import { readFileSync, writeFileSync } from "node:fs";
import { generateLicenseKeyPair, signLicense, EE_FEATURES, type LicensePayload } from "./license.js";

/**
 * License tooling for vendors and self-hosters:
 *   pnpm --filter @tokenledger/ee-licensing license keygen <output-dir>
 *   pnpm --filter @tokenledger/ee-licensing license sign <private-key.pem> <licensee> [plan] [seats] [days]
 *
 * Runtime then needs LICENSE_PUBLIC_KEY (contents of license-public.pem) and
 * LICENSE_KEY (the ttl_… string printed by sign).
 */

const [, , command, ...args] = process.argv;

if (command === "keygen") {
  const dir = args[0] ?? ".";
  const { publicKeyPem, privateKeyPem } = generateLicenseKeyPair();
  writeFileSync(`${dir}/license-public.pem`, publicKeyPem);
  writeFileSync(`${dir}/license-private.pem`, privateKeyPem, { mode: 0o600 });
  console.log(`Wrote ${dir}/license-public.pem  → set as LICENSE_PUBLIC_KEY (or embed in a release build)`);
  console.log(`Wrote ${dir}/license-private.pem → keep offline; used only to sign licenses`);
} else if (command === "sign") {
  const [privateKeyFile, licensee, plan = "enterprise", seats = "50", days = "365"] = args;
  if (!privateKeyFile || !licensee) {
    console.error("usage: license sign <private-key.pem> <licensee> [plan] [seats] [days]");
    process.exit(1);
  }
  const privateKeyPem = readFileSync(privateKeyFile, "utf8");
  const payload: LicensePayload = {
    licensee,
    plan,
    seats: Number(seats),
    features: [...EE_FEATURES],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
  };
  console.log(signLicense(payload, privateKeyPem));
} else {
  console.error("usage: license <keygen|sign>");
  process.exit(1);
}
