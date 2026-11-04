import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Print the SHA-256 of the certificate an APK is signed with.
 *
 * The same value as `apksigner verify --print-certs` ("certificate SHA-256
 * digest"), read straight from the APK's v3/v2 signing block, so it needs no
 * Android build-tools or JDK - this Mac has neither. Compare it with the value
 * in docs/RELEASE.md before sending an APK to the clinic: a different key
 * cannot upgrade her app in place, and uninstalling deletes the database.
 *
 *   node scripts/apk-cert.ts clinic-stock.apk
 *
 * Run with node, never as an npm script: `packageJson:scripts` is an OTA
 * fingerprint source (CLAUDE.md section 10a).
 */

const V2 = 0x7109871a;
const V3 = 0xf05368c0;
const data = readFileSync(process.argv[2]);

/** A uint32-length-prefixed slice, and where the next one starts. */
const lp = (buf: Buffer, off: number): [Buffer, number] => {
  const n = buf.readUInt32LE(off);
  return [buf.subarray(off + 4, off + 4 + n), off + 4 + n];
};

const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const cdOffset = data.readUInt32LE(eocd + 16);
if (data.subarray(cdOffset - 16, cdOffset).toString('latin1') !== 'APK Sig Block 42') {
  console.error('No APK signing block: not a v2/v3-signed APK.');
  process.exit(1);
}
const size = Number(data.readBigUInt64LE(cdOffset - 24));
let off = cdOffset - size;
const blocks = new Map<number, Buffer>();
while (off < cdOffset - 24) {
  const n = Number(data.readBigUInt64LE(off));
  blocks.set(data.readUInt32LE(off + 8), data.subarray(off + 12, off + 8 + n));
  off += 8 + n;
}

for (const [scheme, id] of [['v3', V3], ['v2', V2]] as const) {
  const value = blocks.get(id);
  if (!value) continue;
  const [signers] = lp(value, 0);
  const [signer] = lp(signers, 0);
  const [signedData] = lp(signer, 0);
  const [, afterDigests] = lp(signedData, 0);
  const [certs] = lp(signedData, afterDigests);
  const [cert] = lp(certs, 0);
  console.log(scheme, createHash('sha256').update(cert).digest('hex'));
}
