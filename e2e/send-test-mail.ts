import { ConfigError, readConfig } from "../src/server/config";
import { smtpMailer } from "../src/server/mail";

// Sends one plain test message through the mail server of the configuration (.env), to see that the
// settings are accepted. Prints the outcome by its kind and the mail server's reply code only.
//   npx tsx e2e/send-test-mail.ts someone@example.org

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}
const to = process.argv[2];
if (!to) {
  console.error("Name the recipient:  npx tsx e2e/send-test-mail.ts someone@example.org");
  process.exit(1);
}
try {
  const { config } = readConfig(process.env);
  if (!config.smtp) throw new ConfigError(["SMTP_HOST is not set."]);
  const mailer = await smtpMailer(config.smtp);
  await mailer.send({ to, subject: "Termini Dental: provë e dërgimit", text: "Kjo është një provë. Nëse e lexoni, dërgimi i emailave punon.\n" });
  console.log("accepted by the mail server");
} catch (err) {
  if (err instanceof ConfigError) console.log("configuration:", err.problems.join(" | "));
  else {
    const e = err as { constructor: { name: string }; code?: unknown; responseCode?: unknown; command?: unknown };
    console.log("refused:", e.constructor.name, "code:", e.code ?? "-", "smtp reply:", e.responseCode ?? "-", "at:", e.command ?? "-", "said:", String((e as { response?: unknown }).response ?? "-").slice(0, 200));
  }
  process.exit(1);
}
