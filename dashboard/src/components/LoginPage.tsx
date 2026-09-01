import { useState, type FormEvent } from "react";
import { api } from "../api";

interface Props {
  onLoggedIn: () => void;
  onCreateHouseholdInstead: () => void;
}

/** Formats digits as a US number for display: "303", "(303) 555", "(303)
 * 555-1234". Caps at 10 digits — a leading "1" is dropped since it's added
 * back automatically at submit time. */
function formatUsPhoneDisplay(digits: string): string {
  const d = digits.replace(/^1/, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function LoginPage({ onLoggedIn, onCreateHouseholdInstead }: Props) {
  const [phoneDigits, setPhoneDigits] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A bare 10-digit US number is what people actually type here — the
  // dashboard's own users, not the Sendblue webhook's phone-matching path
  // (src/routes/sendblueWebhook.ts) — so format it for display and submit
  // it as E.164 (+1XXXXXXXXXX) without making anyone type the "+1" or
  // punctuation themselves.
  const phoneE164 = `+1${phoneDigits.replace(/^1/, "").slice(0, 10)}`;

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.requestLoginCode(phoneE164);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send a code — check the number and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.verifyLoginCode(phoneE164, code.trim());
      onLoggedIn();
    } catch {
      setError("That code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <h1>Home Base</h1>
      <p className="subtitle">Log in to your household.</p>
      {step === "phone" ? (
        <form className="card" onSubmit={sendCode}>
          <h2>Log in with your phone</h2>
          <div className="field">
            <label htmlFor="login-phone">Phone number</label>
            <input
              id="login-phone"
              type="tel"
              inputMode="numeric"
              autoFocus
              value={formatUsPhoneDisplay(phoneDigits)}
              onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, ""))}
              placeholder="(303) 555-1234"
              required
            />
          </div>
          <button type="submit" disabled={busy || phoneDigits.replace(/^1/, "").length !== 10}>
            Text me a code
          </button>
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Only a number already verified for a household member will receive a code. New here?{" "}
            <a href="#" onClick={(e) => (e.preventDefault(), onCreateHouseholdInstead())}>
              Create a household
            </a>
            .
          </p>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <h2>Enter your code</h2>
          <p className="hint">We texted a 6-digit code to {formatUsPhoneDisplay(phoneDigits)}.</p>
          <div className="field">
            <label htmlFor="login-code">Code</label>
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
            />
          </div>
          <button type="submit" disabled={busy}>
            Log in
          </button>
          <button type="button" className="secondary" onClick={() => setStep("phone")}>
            Use a different number
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </div>
  );
}
