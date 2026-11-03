import { useEffect, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Fingerprint, ArrowRight } from "lucide-react";
import { account, isFilm, safeNext, startDemo, lastEmail, rememberEmail } from "../auth";
import { Brand } from "../components/UI";
import { ThemeToggle } from "../components/Theme";
import { Field, Resource, useTask } from "../components/Management";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

export function DemoButton({
  size = "default",
}: {
  size?: "default" | "lg" | "sm";
}) {
  const { busy, run } = useTask();
  return (
    <Button size={size} disabled={busy} onClick={() => void run(startDemo)}>
      {busy ? "Opening your workspace…" : "Try the live demo"}
      <ArrowRight />
    </Button>
  );
}
export function AuthPage({
  signup: _signup = false,
  invitationId,
}: {
  signup?: boolean;
  invitationId?: string;
}) {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: account.session,
    enabled: !isFilm(),
    retry: false,
  });
  const invitation = useQuery({
    queryKey: ["invitation", invitationId],
    queryFn: () => account.invitation(invitationId!),
    enabled:
      !!invitationId &&
      !!session.data &&
      !session.data.user.isAnonymous &&
      !isFilm(),
    retry: false,
  });
  const signedIn = !!session.data && !session.data.user.isAnonymous;
  // Someone who already has a signed-in account has nothing to do on the sign-in or sign-up forms.
  useEffect(() => {
    if (signedIn && !invitationId) location.replace(safeNext());
  }, [signedIn, invitationId]);
  const { busy, run } = useTask();
  const next = safeNext();
  const inviteNext = invitationId
    ? `/invite/${encodeURIComponent(invitationId)}`
    : next;
  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex max-w-6xl justify-between p-6">
        <Brand />
        <ThemeToggle />
      </header>
      <main className="auth-layout mx-auto grid max-w-6xl gap-12 px-5 py-10 md:grid-cols-2 md:items-center md:py-20">
        <div className="space-y-5">
          <p className="text-sm">Your shop. Your say.</p>
          <h1 className="text-4xl leading-tight tracking-tight">
            More time for your shop.
            <br />
            <span>Every refund checked.</span>
          </h1>
          <p className="max-w-sm text-sm leading-7 text-muted-foreground">
            Give your agents clear limits, review the exceptions and keep a
            record of every decision.
          </p>
          <p className="text-xs text-muted-foreground">
            PayPal sandbox · Agent API & MCP · Human approvals
          </p>
        </div>
        <Card className="gap-5 p-6 sm:p-8">
          <h2 className="text-xl">
            {invitationId
              ? "Join a workspace"
              : "Sign in or sign up"}
          </h2>
          {invitationId ? (
            <>
              {!session.data || session.data.user.isAnonymous ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Sign in with the invited email address to view the workspace
                    and role, then accept your invitation.
                  </p>
                  <Button asChild>
                    <a href={`/signin?next=${encodeURIComponent(inviteNext)}`}>
                      Sign in
                    </a>
                  </Button>

                </>
              ) : (
                <>
                  <Resource query={invitation}>
                    {invitation.data && (
                      <>
                        <p className="text-sm">
                          You've been invited to{" "}
                          <strong>{invitation.data.organizationName}</strong> as{" "}
                          <Badge variant="secondary">
                            {invitation.data.role}
                          </Badge>
                          .
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Invitation for {invitation.data.email}
                        </p>
                        <Button
                          disabled={
                            busy || invitation.data.status !== "pending"
                          }
                          onClick={() =>
                            void run(async () => {
                              await account.accept(invitationId);
                              await account.setActive(
                                invitation.data!.organizationId,
                              );
                              location.assign("/app");
                            })
                          }
                        >
                          {invitation.data.status === "pending"
                            ? "Accept invitation"
                            : `Invitation ${invitation.data.status}`}
                        </Button>
                      </>
                    )}
                  </Resource>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await account.signOut();
                        location.assign(
                          `/signin?next=${encodeURIComponent(inviteNext)}`,
                        );
                      })
                    }
                  >
                    Use a different account
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Your approvals and rules follow you to every device</p>
              <SignInForm demo={Boolean(session.data?.user.isAnonymous)} />
            </>
          )}
        </Card>
      </main>
    </div>
  );
}

function mailbox(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (["gmail.com", "googlemail.com"].includes(domain)) return ["Gmail", "https://mail.google.com"];
  if (["outlook.com", "hotmail.com", "live.com"].includes(domain)) return ["Outlook", "https://outlook.live.com/mail"];
  if (["yahoo.com", "ymail.com"].includes(domain)) return ["Yahoo", "https://mail.yahoo.com"];
  if (["icloud.com", "me.com", "mac.com"].includes(domain)) return ["iCloud", "https://www.icloud.com/mail"];
  return null;
}
function SignInForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [last] = useState(lastEmail);
  const [mode, setMode] = useState<"code" | "password" | "reset">("code");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [hint, setHint] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!seconds) return;
    const timer = setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  const consent = () => { if (!agreed) { setHint(true); return false; } return true; };
  async function task(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { lock.current = false; setBusy(false); }
  }
  function finish(created = false) {
    if (email.trim()) rememberEmail(email.trim().toLowerCase());
    const url = new URL(safeNext(), location.origin);
    url.searchParams.set("authNotice", (created ? "Account created. Welcome!" : "Signed in") + (demo ? " Your demo workspace has been kept." : ""));
    location.assign(url.pathname + url.search + url.hash);
  }
  async function send(to = email) {
    if (!consent()) return;
    await task(async () => {
      await account.sendCode(to.trim(), mode === "reset" ? "forget-password" : "sign-in", keep);
      setEmail(to.trim()); setSent(true); setCode(""); setSeconds(60);
      if (demo) sessionStorage.setItem("floorwalker:demo-link", "1");
    });
  }
  async function submit(otp = code) {
    if (!consent()) return;
    await task(async () => {
      if (mode === "password") { await account.signIn(email.trim(), password, keep); finish(); }
      else if (mode === "reset") {
        await account.resetPassword(email.trim(), otp, password);
        await account.signIn(email.trim(), password, keep); finish();
      } else { const result = await account.verifyCode(email.trim(), otp, keep); finish(result.created); }
    });
  }
  function switchMode(value: typeof mode) { setMode(value); setSent(false); setCode(""); setPassword(""); setError(""); }
  const inbox = mailbox(email);
  return <div className="space-y-4">
    {demo && <p className="text-sm">Your demo workspace comes with you.</p>}
    {mode === "reset" && <h3>Forgot password</h3>}
    {!sent && mode === "code" && last && <>
      <Button variant="outline" className="w-full" disabled={busy} onClick={() => void send(last)}>Continue as {last}</Button>
      <p className="text-center text-sm">or use another email</p>
    </>}
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (mode !== "password" && !sent) void send(); else void submit(); }}>
      <Field label="Email"><Input required type="email" autoComplete="email" readOnly={sent} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {mode !== "password" && <>
        <Button type="button" variant="outline" disabled={busy || seconds > 0 || !email.trim()} onClick={() => void send()}>{seconds ? `Resend in ${seconds}s` : "Send code"}</Button>
        <p className="text-xs text-muted-foreground">New emails get an account after verification.</p>
      </>}
      {sent && <>
        <p className="text-xs">Code sent to {email}, valid for 10 minutes · <button type="button" className="underline" onClick={() => { setSent(false); setCode(""); setError(""); }}>Change</button></p>
        <Field label="Code"><Input required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} aria-invalid={error.includes("tries left") || undefined} value={code} onChange={(e) => {
          const value = e.target.value.replace(/\D/g, "").slice(0, 6); setCode(value);
          if (value.length === 6 && mode === "code") void submit(value);
        }} /></Field>
        {inbox && <Button asChild variant="outline"><a href={inbox[1]} target="_blank" rel="noreferrer">Open {inbox[0]}</a></Button>}
      </>}
      {(mode === "password" || (mode === "reset" && sent)) && <Field label={mode === "reset" ? "New password" : "Password"} hint={mode === "reset" ? "8 to 200 characters" : undefined}>
        <div className="flex gap-2"><Input required type={show ? "text" : "password"} minLength={mode === "reset" ? 8 : 1} maxLength={200} autoComplete={mode === "reset" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /><Button type="button" variant="outline" onClick={() => setShow(!show)}>{show ? "Hide password" : "Show password"}</Button></div>
      </Field>}
      <div className="text-sm space-y-1"><label className="flex gap-2"><input type="checkbox" checked={agreed} onChange={(e) => { setAgreed(e.target.checked); setHint(false); }} /><span>I agree to the <a className="underline" href="/terms">Terms</a> and the <a className="underline" href="/privacy">Privacy notice</a></span></label>{hint && <p role="alert" className="text-destructive">Please agree to the Terms and the Privacy notice to continue.</p>}</div>
      <div className="flex flex-wrap justify-between gap-3 text-xs"><label className="flex gap-2"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep me signed in for 30 days</label>{mode === "code" && <button type="button" className="underline" onClick={() => switchMode("password")}>Sign in with a password</button>}</div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {error.includes("doesn't have a password") && <Button type="button" variant="outline" onClick={() => switchMode("code")}>Use a code instead</Button>}
      <Button className="w-full" type="submit" disabled={busy || isFilm()}>{busy ? "Please wait…" : "Continue"}</Button>
    </form>
    {mode !== "code" && <div className="flex justify-between text-sm">{mode === "password" && <button className="underline" onClick={() => switchMode("reset")}>Forgot password</button>}<button className="underline" onClick={() => switchMode("code")}>Use a code instead</button></div>}
    {sent && <div className="space-y-3 border-t pt-4"><p className="text-sm">Didn't get the code?</p><Button variant="outline" disabled={busy || seconds > 0} onClick={() => void send()}>Send a new code</Button></div>}
    <Button variant="outline" disabled={busy || isFilm()} onClick={() => { if (consent()) void task(async () => { await account.passkeySignIn(keep); finish(); }); }}><Fingerprint />Sign in with a passkey</Button>
    <div className="border-t pt-4"><Button variant="ghost" disabled={busy} onClick={() => void task(startDemo)}>Try the live demo without an account</Button></div>
  </div>;
}

export function AuthNotice() {
  useEffect(() => {
    const url = new URL(location.href);
    const incoming = url.searchParams.get("authNotice");
    const notice = incoming?.startsWith("Account created. Welcome!") ? "Account created. Welcome!" : incoming?.startsWith("Signed in") ? "Signed in" : null;
    if (!notice) return;
    const demo = sessionStorage.getItem("floorwalker:demo-link");
    sessionStorage.removeItem("floorwalker:demo-link");
    toast.success(notice + (demo ? " Your demo workspace has been kept." : ""));
    url.searchParams.delete("authNotice"); history.replaceState(null, "", url);
    void account.session().then((s) => { if (s && !s.user.isAnonymous) rememberEmail(s.user.email); });
  }, []);
  return null;
}

export function AuthAdmin() {
  const stats = useQuery({ queryKey: ["auth-stats"], retry: false, queryFn: async () => {
    const res = await fetch("/api/admin/auth-stats");
    if (!res.ok) throw new Error("Admin access required.");
    return res.json() as Promise<{ day: string; newAccounts: number; signIns: number; codesSent: number; conversion: number }[]>;
  } });
  return <main className="mx-auto max-w-4xl p-8 space-y-6"><Brand />{stats.isError ? <p>Admin access required.</p> : stats.isPending ? <p>Loading…</p> : <><h1>Sign-in events</h1><table className="w-full text-sm"><thead><tr>{["Day", "New accounts", "Sign-ins", "Codes sent", "Code-to-sign-in"].map((h) => <th className="border-b p-3 text-left" key={h}>{h}</th>)}</tr></thead><tbody>{stats.data.map((d) => <tr key={d.day}>{[d.day, d.newAccounts, d.signIns, d.codesSent, `${(d.conversion * 100).toFixed(1)}%`].map((v, i) => <td key={i} className="border-b p-3">{v}</td>)}</tr>)}</tbody></table><p className="text-xs">Daily code/link sign-ins divided by codes sent (UTC). Delayed sign-ins may fall on a later day.</p></>}<a href="/app">Back to workspace</a></main>;
}
