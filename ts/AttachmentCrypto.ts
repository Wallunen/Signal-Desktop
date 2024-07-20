// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { unlinkSync, createReadStream, createWriteStream } from 'fs';
import { open } from 'fs/promises';
import { createCipheriv, createHash, createHmac, randomBytes } from 'crypto';
import type { Hash } from 'crypto';
import { PassThrough, Transform, type Writable, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureFile } from 'fs-extra';
import * as log from './logging/log';
import {
  HashType,
  CipherType,
  IV_LENGTH,
  KEY_LENGTH,
  MAC_LENGTH,
} from './types/Crypto';
import { constantTimeEqual } from './Crypto';
import { createName, getRelativePath } from './util/attachmentPath';
import { appendPaddingStream, logPadSize } from './util/logPadding';
import { prependStream } from './util/prependStream';
import { appendMacStream } from './util/appendMacStream';
import { finalStream } from './util/finalStream';
import { getIvAndDecipher } from './util/getIvAndDecipher';
import { getMacAndUpdateHmac } from './util/getMacAndUpdateHmac';
import { trimPadding } from './util/trimPadding';
import { strictAssert } from './util/assert';
import * as Errors from './types/errors';
import { isNotNil } from './util/isNotNil';
import { missingCaseError } from './util/missingCaseError';
import { getEnvironment, Environment } from './environment';
import { toBase64 } from './Bytes';

// This file was split from ts/Crypto.ts because it pulls things in from node, and
//   too many things pull in Crypto.ts, so it broke storybook.

const DIGEST_LENGTH = MAC_LENGTH;
const HEX_DIGEST_LENGTH = DIGEST_LENGTH * 2;
const ATTACHMENT_MAC_LENGTH = MAC_LENGTH;

export class ReencryptedDigestMismatchError extends Error {}

/** @private */
export const KEY_SET_LENGTH = KEY_LENGTH + MAC_LENGTH;

export function _generateAttachmentIv(): Uint8Array {
  return randomBytes(IV_LENGTH);
}

export function generateAttachmentKeys(): Uint8Array {
  return randomBytes(KEY_SET_LENGTH);
}

export type EncryptedAttachmentV2 = {
  digest: Uint8Array;
  iv: Uint8Array;
  plaintextHash: string;
  ciphertextSize: number;
};

export type ReencryptedAttachmentV2 = {
  path: string;
  iv: string;
  plaintextHash: string;
  localKey: string;
  version: 2;
};

export type DecryptedAttachmentV2 = {
  path: string;
  iv: Uint8Array;
  plaintextHash: string;
};

export type PlaintextSourceType =
  | { data: Uint8Array }
  | { stream: Readable }
  | { absolutePath: string };

export type HardcodedIVForEncryptionType =
  | {
      reason: 'test';
      iv: Uint8Array;
    }
  | {
      reason: 'reencrypting-for-backup';
      iv: Uint8Array;
      digestToMatch: Uint8Array;
    };

type EncryptAttachmentV2PropsType = {
  plaintext: PlaintextSourceType;
  keys: Readonly<Uint8Array>;
  dangerousIv?: HardcodedIVForEncryptionType;
  dangerousTestOnlySkipPadding?: boolean;
  getAbsoluteAttachmentPath: (relativePath: string) => string;
};

export async function encryptAttachmentV2ToDisk(
  args: EncryptAttachmentV2PropsType
): Promise<EncryptedAttachmentV2 & { path: string }> {
  // Create random output file
  const relativeTargetPath = getRelativePath(createName());
  const absoluteTargetPath = args.getAbsoluteAttachmentPath(relativeTargetPath);

  await ensureFile(absoluteTargetPath);

  let encryptResult: EncryptedAttachmentV2;

  try {
    encryptResult = await encryptAttachmentV2({
      ...args,
      sink: createWriteStream(absoluteTargetPath),
    });
  } catch (error) {
    safeUnlinkSync(absoluteTargetPath);
    throw error;
  }

  return {
    ...encryptResult,
    path: relativeTargetPath,
  };
}
export async function encryptAttachmentV2({
  keys,
  plaintext,
  dangerousIv,
  dangerousTestOnlySkipPadding,
  sink,
}: EncryptAttachmentV2PropsType & {
  sink?: Writable;
}): Promise<EncryptedAttachmentV2> {
  const logId = 'encryptAttachmentV2';

  const { aesKey, macKey } = splitKeys(keys);

  if (dangerousIv) {
    if (dangerousIv.reason === 'test') {
      if (getEnvironment() !== Environment.Test) {
        throw new Error(
          `${logId}: Used dangerousIv with reason test outside tests!`
        );
      }
    } else if (dangerousIv.reason === 'reencrypting-for-backup') {
      strictAssert(
        dangerousIv.digestToMatch.byteLength === DIGEST_LENGTH,
        `${logId}: Must provide valid digest to match if providing iv for re-encryption`
      );
      log.info(
        `${logId}: using hardcoded iv because we are re-encrypting for backup`
      );
    } else {
      throw missingCaseError(dangerousIv);
    }
  }

  if (dangerousTestOnlySkipPadding && getEnvironment() !== Environment.Test) {
    throw new Error(
      `${logId}: Used dangerousTestOnlySkipPadding outside tests!`
    );
  }

  const iv = dangerousIv?.iv || _generateAttachmentIv();
  const plaintextHash = createHash(HashType.size256);
  const digest = createHash(HashType.size256);

  let ciphertextSize: number | undefined;
  let mac: Uint8Array | undefined;

  try {
    let source: Readable;
    if ('data' in plaintext) {
      source = Readable.from([Buffer.from(plaintext.data)]);
    } else if ('stream' in plaintext) {
      source = plaintext.stream;
    } else {
      source = createReadStream(plaintext.absolutePath);
    }

    await pipeline(
      [
        source,
        peekAndUpdateHash(plaintextHash),
        dangerousTestOnlySkipPadding ? undefined : appendPaddingStream(),
        createCipheriv(CipherType.AES256CBC, aesKey, iv),
        prependIv(iv),
        appendMacStream(macKey, macValue => {
          mac = macValue;
        }),
        peekAndUpdateHash(digest),
        measureSize(size => {
          ciphertextSize = size;
        }),
        sink ?? new PassThrough().resume(),
      ].filter(isNotNil)
    );
  } catch (error) {
    log.error(
      `${logId}: Failed to encrypt attachment`,
      Errors.toLogFormat(error)
    );
    throw error;
  }

  const ourPlaintextHash = plaintextHash.digest('hex');
  const ourDigest = digest.digest();

  strictAssert(
    ourPlaintextHash.length === HEX_DIGEST_LENGTH,
    `${logId}: Failed to generate plaintext hash!`
  );

  strictAssert(
    ourDigest.byteLength === DIGEST_LENGTH,
    `${logId}: Failed to generate ourDigest!`
  );

  strictAssert(ciphertextSize != null, 'Failed to measure ciphertext size!');
  strictAssert(mac != null, 'Failed to compute mac!');

  if (dangerousIv?.reason === 'reencrypting-for-backup') {
    if (!constantTimeEqual(ourDigest, dangerousIv.digestToMatch)) {
      throw new ReencryptedDigestMismatchError(
        `${logId}: iv was hardcoded for backup re-encryption, but digest does not match`
      );
    }
  }

  return {
    digest: ourDigest,
    iv,
    plaintextHash: ourPlaintextHash,
    ciphertextSize,
  };
}

type DecryptAttachmentToSinkOptionsType = Readonly<
  {
    ciphertextPath: string;
    idForLogging: string;
    size: number;
    outerEncryption?: {
      aesKey: Readonly<Uint8Array>;
      macKey: Readonly<Uint8Array>;
    };
  } & (
    | {
        type: 'standard';
        theirDigest: Readonly<Uint8Array>;
      }
    | {
        // No need to check integrity for locally reencrypted attachments, or for backup
        // thumbnails (since we created it)
        type: 'local' | 'backupThumbnail';
        theirDigest?: undefined;
      }
  ) &
    (
      | {
          aesKey: Readonly<Uint8Array>;
          macKey: Readonly<Uint8Array>;
        }
      | {
          // The format used by most stored attachments
          keysBase64: string;
        }
    )
>;

export type DecryptAttachmentOptionsType = DecryptAttachmentToSinkOptionsType &
  Readonly<{
    getAbsoluteAttachmentPath: (relativePath: string) => string;
  }>;

export async function decryptAttachmentV2(
  options: DecryptAttachmentOptionsType
): Promise<DecryptedAttachmentV2> {
  const logId = `decryptAttachmentV2(${options.idForLogging})`;

  // Create random output file
  const relativeTargetPath = getRelativePath(createName());
  const absoluteTargetPath =
    options.getAbsoluteAttachmentPath(relativeTargetPath);

  let writeFd;
  try {
    try {
      await ensureFile(absoluteTargetPath);
      writeFd = await open(absoluteTargetPath, 'w');
    } catch (cause) {
      throw new Error(`${logId}: Failed to create write path`, { cause });
    }

    const result = await decryptAttachmentV2ToSink(
      options,
      writeFd.createWriteStream()
    );

    return {
      ...result,
      path: relativeTargetPath,
    };
  } catch (error) {
    log.error(
      `${logId}: Failed to decrypt attachment to disk`,
      Errors.toLogFormat(error)
    );
    safeUnlinkSync(absoluteTargetPath);
    throw error;
  } finally {
    await writeFd?.close();
  }
}

export async function decryptAttachmentV2ToSink(
  options: DecryptAttachmentToSinkOptionsType,
  sink: Writable
): Promise<Omit<DecryptedAttachmentV2, 'path'>> {
  const { idForLogging, ciphertextPath, outerEncryption } = options;

  let aesKey: Uint8Array;
  let macKey: Uint8Array;

  if ('aesKey' in options) {
    ({ aesKey, macKey } = options);
  } else {
    const { keysBase64 } = options;
    const keys = Buffer.from(keysBase64, 'base64');

    ({ aesKey, macKey } = splitKeys(keys));
  }

  const logId = `decryptAttachmentV2(${idForLogging})`;

  const digest = createHash(HashType.size256);
  const hmac = createHmac(HashType.size256, macKey);
  const plaintextHash = createHash(HashType.size256);
  let theirMac: Uint8Array | undefined;

  // When downloading from backup there is an outer encryption layer; in that case we
  // need to decrypt the outer layer and check its MAC
  let theirOuterMac: Uint8Array | undefined;
  const outerHmac = outerEncryption
    ? createHmac(HashType.size256, outerEncryption.macKey)
    : undefined;

  const maybeOuterEncryptionGetIvAndDecipher = outerEncryption
    ? getIvAndDecipher(outerEncryption.aesKey)
    : undefined;

  const maybeOuterEncryptionGetMacAndUpdateMac = outerHmac
    ? getMacAndUpdateHmac(outerHmac, theirOuterMacValue => {
        theirOuterMac = theirOuterMacValue;
      })
    : undefined;

  let readFd;
  let iv: Uint8Array | undefined;
  try {
    try {
      readFd = await open(ciphertextPath, 'r');
    } catch (cause) {
      throw new Error(`${logId}: Read path doesn't exist`, { cause });
    }

    await pipeline(
      [
        readFd.createReadStream(),
        maybeOuterEncryptionGetMacAndUpdateMac,
        maybeOuterEncryptionGetIvAndDecipher,
        peekAndUpdateHash(digest),
        getMacAndUpdateHmac(hmac, theirMacValue => {
          theirMac = theirMacValue;
        }),
        getIvAndDecipher(aesKey, theirIv => {
          iv = theirIv;
        }),
        trimPadding(options.size),
        peekAndUpdateHash(plaintextHash),
        finalStream(() => {
          const ourMac = hmac.digest();
          const ourDigest = digest.digest();

          strictAssert(
            ourMac.byteLength === ATTACHMENT_MAC_LENGTH,
            `${logId}: Failed to generate ourMac!`
          );
          strictAssert(
            theirMac != null && theirMac.byteLength === ATTACHMENT_MAC_LENGTH,
            `${logId}: Failed to find theirMac!`
          );
          strictAssert(
            ourDigest.byteLength === DIGEST_LENGTH,
            `${logId}: Failed to generate ourDigest!`
          );

          if (!constantTimeEqual(ourMac, theirMac)) {
            throw new Error(`${logId}: Bad MAC`);
          }

          const { type } = options;
          switch (type) {
            case 'local':
            case 'backupThumbnail':
              log.info(
                `${logId}: skipping digest check since this is a ${type} attachment`
              );
              break;
            case 'standard':
              if (!constantTimeEqual(ourDigest, options.theirDigest)) {
                throw new Error(`${logId}: Bad digest`);
              }
              break;
            default:
              throw missingCaseError(type);
          }

          if (!outerEncryption) {
            return;
          }

          strictAssert(outerHmac, 'outerHmac must exist');

          const ourOuterMac = outerHmac.digest();
          strictAssert(
            ourOuterMac.byteLength === ATTACHMENT_MAC_LENGTH,
            `${logId}: Failed to generate ourOuterMac!`
          );
          strictAssert(
            theirOuterMac != null &&
              theirOuterMac.byteLength === ATTACHMENT_MAC_LENGTH,
            `${logId}: Failed to find theirOuterMac!`
          );

          if (!constantTimeEqual(ourOuterMac, theirOuterMac)) {
            throw new Error(`${logId}: Bad outer encryption MAC`);
          }
        }),
        sink,
      ].filter(isNotNil)
    );
  } catch (error) {
    // These errors happen when canceling fetch from `attachment://` urls,
    // ignore them to avoid noise in the logs.
    if (error.name === 'AbortError') {
      throw error;
    }

    log.error(
      `${logId}: Failed to decrypt attachment`,
      Errors.toLogFormat(error)
    );
    throw error;
  } finally {
    await readFd?.close();
  }

  const ourPlaintextHash = plaintextHash.digest('hex');
  strictAssert(
    ourPlaintextHash.length === HEX_DIGEST_LENGTH,
    `${logId}: Failed to generate file hash!`
  );

  strictAssert(
    iv != null && iv.byteLength === IV_LENGTH,
    `${logId}: failed to find their iv`
  );

  return {
    iv,
    plaintextHash: ourPlaintextHash,
  };
}

export async function decryptAndReencryptLocally(
  options: DecryptAttachmentOptionsType
): Promise<ReencryptedAttachmentV2> {
  const { idForLogging } = options;

  const logId = `reencryptAttachmentV2(${idForLogging})`;

  // Create random output file
  const relativeTargetPath = getRelativePath(createName());
  const absoluteTargetPath =
    options.getAbsoluteAttachmentPath(relativeTargetPath);

  let writeFd;
  try {
    try {
      await ensureFile(absoluteTargetPath);
      writeFd = await open(absoluteTargetPath, 'w');
    } catch (cause) {
      throw new Error(`${logId}: Failed to create write path`, { cause });
    }

    const keys = generateKeys();

    const passthrough = new PassThrough();
    const [result] = await Promise.all([
      decryptAttachmentV2ToSink(options, passthrough),
      await encryptAttachmentV2({
        keys,
        plaintext: {
          stream: passthrough,
        },
        sink: createWriteStream(absoluteTargetPath),
        getAbsoluteAttachmentPath: options.getAbsoluteAttachmentPath,
      }),
    ]);

    return {
      ...result,
      localKey: toBase64(keys),
      iv: toBase64(result.iv),
      path: relativeTargetPath,
      version: 2,
    };
  } catch (error) {
    log.error(
      `${logId}: Failed to decrypt attachment`,
      Errors.toLogFormat(error)
    );
    safeUnlinkSync(absoluteTargetPath);
    throw error;
  } finally {
    await writeFd?.close();
  }
}

/**
 * Splits the keys into aes and mac keys.
 */

type AttachmentEncryptionKeysType = {
  aesKey: Uint8Array;
  macKey: Uint8Array;
};
export function splitKeys(keys: Uint8Array): AttachmentEncryptionKeysType {
  strictAssert(
    keys.byteLength === KEY_SET_LENGTH,
    `attachment keys must be ${KEY_SET_LENGTH} bytes, got ${keys.byteLength}`
  );
  const aesKey = keys.subarray(0, KEY_LENGTH);
  const macKey = keys.subarray(KEY_LENGTH, KEY_SET_LENGTH);
  return { aesKey, macKey };
}

export function generateKeys(): Uint8Array {
  return randomBytes(KEY_SET_LENGTH);
}

/**
 * Updates a hash of the stream without modifying it.
 */
function peekAndUpdateHash(hash: Hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        hash.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
}

export function measureSize(onComplete: (size: number) => void): Transform {
  let totalBytes = 0;
  const passthrough = new PassThrough();
  passthrough.on('data', chunk => {
    totalBytes += chunk.length;
  });
  passthrough.on('end', () => {
    onComplete(totalBytes);
  });
  return passthrough;
}

export function getAttachmentCiphertextLength(plaintextLength: number): number {
  const paddedPlaintextSize = logPadSize(plaintextLength);

  return (
    IV_LENGTH +
    getAesCbcCiphertextLength(paddedPlaintextSize) +
    ATTACHMENT_MAC_LENGTH
  );
}

export function getAesCbcCiphertextLength(plaintextLength: number): number {
  const AES_CBC_BLOCK_SIZE = 16;
  return (
    (1 + Math.floor(plaintextLength / AES_CBC_BLOCK_SIZE)) * AES_CBC_BLOCK_SIZE
  );
}

/**
 * Prepends the iv to the stream.
 */
function prependIv(iv: Uint8Array) {
  strictAssert(
    iv.byteLength === IV_LENGTH,
    `prependIv: iv should be ${IV_LENGTH} bytes, got ${iv.byteLength} bytes`
  );
  return prependStream(iv);
}

export function getPlaintextHashForInMemoryAttachment(
  data: Uint8Array
): string {
  return createHash(HashType.size256).update(data).digest('hex');
}

/**
 * Unlinks a file without throwing an error if it doesn't exist.
 * Throws an error if it fails to unlink for any other reason.
 */
export function safeUnlinkSync(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    // Ignore if file doesn't exist
    if (error.code !== 'ENOENT') {
      log.error('Failed to unlink', error);
      throw error;
    }
  }
}
