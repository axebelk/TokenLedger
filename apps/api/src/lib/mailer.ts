import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "@tokentrail/telemetry";

export interface Mailer {
  send(to: string, subject: string, html: string, text: string): Promise<void>;
}

/** SMTP mailer (mailpit in dev). Without SMTP_URL, mails are logged instead. */
export function createMailer(smtpUrl: string | undefined, logger: Logger, from: string): Mailer {
  if (!smtpUrl) {
    logger.warn("SMTP_URL not set — emails will be logged, not sent");
    return {
      async send(to, subject, _html, text) {
        logger.info({ to, subject, text }, "email (not sent — no SMTP configured)");
      },
    };
  }
  const transport: Transporter = nodemailer.createTransport(smtpUrl);
  return {
    async send(to, subject, html, text) {
      await transport.sendMail({ from, to, subject, html, text });
    },
  };
}

export function inviteEmail(opts: {
  workspaceName: string;
  inviterName: string;
  acceptUrl: string;
}): { subject: string; html: string; text: string } {
  const { workspaceName, inviterName, acceptUrl } = opts;
  return {
    subject: `${inviterName} invited you to ${workspaceName} on TokenTrail`,
    text: `${inviterName} invited you to the "${workspaceName}" workspace on TokenTrail.\n\nAccept the invitation: ${acceptUrl}\n\nThis link expires in 7 days.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px">
        <h2>You're invited to ${escapeHtml(workspaceName)}</h2>
        <p>${escapeHtml(inviterName)} invited you to their TokenTrail workspace.</p>
        <p><a href="${acceptUrl}" style="background:#3b5bdb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
        <p style="color:#888;font-size:12px">This link expires in 7 days. If you weren't expecting this, ignore this email.</p>
      </div>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
