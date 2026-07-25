import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import crypto from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distDir = join(root, "dist");
const keyFile = join(root, "key.pem");

function encodeVarint(value) {
  const buf = [];
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  buf.push(value & 0x7f);
  return Buffer.from(buf);
}

/**
 * Encode a protobuf length-delimited field: tag + length(varint) + data.
 * tag = (fieldNumber << 3) | 2 (wire type 2 = length-delimited)
 */
function encodeBytesField(fieldNumber, data) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

/**
 * Encode a protobuf sub-message field: tag + length(varint) + encoded_message.
 */
function encodeMessageField(fieldNumber, message) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(message.length);
  return Buffer.concat([tag, len, message]);
}

/**
 * Build the CrxFileHeader protobuf message.
 * CrxFileHeader { sha256_with_rsa: [AsymmetricKeyProof] }
 * AsymmetricKeyProof { public_key, signature }
 */
function buildCrxFileHeader(publicKeyDer, signatureBytes) {
  // AsymmetricKeyProof
  const pkField = encodeBytesField(1, publicKeyDer);
  const sigField = encodeBytesField(2, signatureBytes);
  const keyProof = Buffer.concat([pkField, sigField]);

  // CrxFileHeader.sha256_with_rsa (field number 2)
  const headerContent = encodeMessageField(2, keyProof);
  return headerContent;
}

function createZip(dirPath, outputPath) {
  execSync(`zip -r "${outputPath}" .`, { cwd: dirPath, stdio: "inherit" });
}

async function main() {
  const commitId = process.argv[2];
  if (!commitId) {
    console.error("Usage: node pack-crx.mjs <commit-id>");
    process.exit(1);
  }

  const crxName = `TuntaExtension_build_${commitId}.crx`;
  const crxPath = join(root, crxName);
  const zipPath = join(root, ".tmp-ext.zip");

  // 1. Create zip of dist
  console.log("Creating zip from dist/...");
  createZip(distDir, zipPath);
  const zipData = await readFile(zipPath);

  // 2. Generate or load RSA key
  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(keyFile, "utf-8");
    console.log("Using existing key.pem");
  } catch {
    console.log("Generating new RSA key pair...");
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;
    writeFileSync(keyFile, privateKeyPem);
    console.log("Saved key.pem");
  }

  // 3. SHA-256 hash of zip content
  const hash = crypto.createHash("sha256").update(zipData).digest();

  // 4. Sign with RSA
  const signature = crypto.sign("sha256", hash, {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });

  // 5. Get DER-encoded public key
  const pubKeyObj = crypto.createPublicKey(privateKeyPem);
  const publicKeyDer = pubKeyObj.export({ type: "spki", format: "der" });

  // 6. Build CRX v3 header
  const crxHeader = buildCrxFileHeader(publicKeyDer, signature);

  // 7. Write CRX file
  const magic = Buffer.from("Cr24", "ascii");
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(crxHeader.length, 0);

  const crxData = Buffer.concat([magic, version, headerLen, crxHeader, zipData]);
  await writeFile(crxPath, crxData);

  console.log(`Created: ${crxName} (${(crxData.length / 1024).toFixed(1)} KB)`);

  // Cleanup
  await unlink(zipPath).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
