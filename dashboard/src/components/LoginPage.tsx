import { useState, type FormEvent } from "react";
import { api } from "../api";

interface Props {
  onLoggedIn: () => void;
  onCreateHouseholdInstead: () => void;
}

export function LoginPage({ onLoggedIn, onCreateHouseholdInstead }: Props) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.requestLoginCode(phone.trim());
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
      await api.verifyLoginCode(phone.trim(), code.trim());
      onLoggedIn();
    } catch {
      setError("That code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
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
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+13035551234"
              required
            />
          </div>
          <button type="submit" disabled={busy}>
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
          <p className="hint">We texted a 6-digit code to {phone}.</p>
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
    </>
  );
}
