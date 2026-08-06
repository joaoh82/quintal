import 'server-only';

export interface MagicLinkEmail {
  to: string;
  url: string;
}

/** Which transport is configured, in priority order. */
function transport(): 'resend' | 'smtp' | 'console' {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'console';
}

const FROM = process.env.EMAIL_FROM ?? 'Quintal <noreply@localhost>';
const SUBJECT = 'Your Quintal sign-in link';

function body(url: string): { text: string; html: string } {
  return {
    text: `Sign in to Quintal:\n\n${url}\n\nThis link expires shortly and can only be used once. If you didn't request it, ignore this email.`,
    html: `<p>Sign in to Quintal:</p><p><a href="${url}">Open Quintal</a></p><p style="color:#666;font-size:12px">This link expires shortly and can only be used once. If you didn't request it, ignore this email.</p>`,
  };
}

/**
 * Send a magic link. Three tiers, so a self-hoster can get running with no
 * email provider at all:
 *
 *   1. RESEND_API_KEY set  -> Resend
 *   2. SMTP_HOST set       -> generic SMTP
 *   3. neither             -> print the link to the server console
 */
export async function sendMagicLinkEmail({
  to,
  url,
}: MagicLinkEmail): Promise<void> {
  const { text, html } = body(url);

  switch (transport()) {
    case 'resend': {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: FROM,
        to,
        subject: SUBJECT,
        text,
        html,
      });
      if (error) throw new Error(`Resend failed: ${error.message}`);
      return;
    }

    case 'smtp': {
      const nodemailer = await import('nodemailer');
      const port = Number(process.env.SMTP_PORT ?? 587);
      const mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        // Implicit TLS on 465; STARTTLS everywhere else.
        secure: process.env.SMTP_SECURE
          ? process.env.SMTP_SECURE === 'true'
          : port === 465,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' }
          : undefined,
      });
      await mailer.sendMail({ from: FROM, to, subject: SUBJECT, text, html });
      return;
    }

    case 'console': {
      console.log(
        [
          '',
          '  ┌─ Quintal sign-in link ' + '─'.repeat(40),
          `  │  to:  ${to}`,
          `  │  url: ${url}`,
          '  │',
          '  │  No email provider configured (set RESEND_API_KEY or SMTP_HOST).',
          '  └' + '─'.repeat(63),
          '',
        ].join('\n'),
      );
      return;
    }
  }
}
