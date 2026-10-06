// Invio dell'email di allerta via Resend, condiviso da scripts/monitor.ts (GitHub Actions) e dal
// controllo di coerenza dentro il tick (Vercel). Best-effort: un problema con l'email non deve mai
// far fallire il chiamante, e il motivo viene restituito invece di essere silenziato.
//
// Richiede RESEND_API_KEY nell'ambiente di chi chiama: su GitHub Actions è già un secret del repo,
// su Vercel va impostata a parte (Project Settings → Environment Variables).

export const ALERT_EMAIL = "nicolaforria@gmail.com";

export async function sendAlertEmail(subject: string, lines: string[]): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "RESEND_API_KEY mancante nell'ambiente" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "WHAD Trading <onboarding@resend.dev>",
        to: [ALERT_EMAIL],
        subject,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) return { sent: false, reason: `Resend ha risposto ${res.status} ${await res.text().catch(() => "")}`.trim() };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err as Error).message };
  }
}
