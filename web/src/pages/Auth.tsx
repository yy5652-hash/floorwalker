import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Fingerprint, ArrowRight } from "lucide-react";
import { account, isFilm, safeNext, startDemo } from "../auth";
import { Brand } from "../components/UI";
import { ThemeToggle } from "../components/Theme";
import { Field, Resource, useTask } from "../components/Management";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
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
  signup = false,
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
            <span className="text-allow">Every refund checked.</span>
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
              : signup
                ? "Create your account"
                : "Welcome back"}
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
                  <Button asChild variant="outline">
                    <a href={`/signup?next=${encodeURIComponent(inviteNext)}`}>
                      Create account
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
              {signup && session.data?.user.isAnonymous && (
                <p className="rounded-lg bg-allow/10 p-3 text-sm text-allow">
                  Your demo workspace comes with you.
                </p>
              )}
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (signup)
                      await account.signUp(name.trim(), email.trim(), password);
                    else await account.signIn(email.trim(), password);
                    location.assign(next);
                  });
                }}
              >
                {signup && (
                  <Field label="Full name">
                    <Input
                      required
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={100}
                    />
                  </Field>
                )}
                <Field label="Email">
                  <Input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field
                  label="Password"
                  hint={signup ? "At least 10 characters." : undefined}
                >
                  <Input
                    required
                    type="password"
                    minLength={signup ? 10 : 1}
                    autoComplete={signup ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={busy || isFilm()}
                  className="w-full"
                >
                  {busy
                    ? "Please wait…"
                    : signup
                      ? "Create account"
                      : "Sign in"}
                </Button>
              </form>
              {!signup && (
                <Button
                  variant="outline"
                  disabled={busy || isFilm()}
                  onClick={() =>
                    void run(async () => {
                      await account.passkeySignIn();
                      location.assign(next);
                    })
                  }
                >
                  <Fingerprint />
                  Sign in with a passkey
                </Button>
              )}
              <p className="text-center text-sm text-muted-foreground">
                {signup ? "Already have an account?" : "New to Floorwalker?"}{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href={`/${signup ? "signin" : "signup"}?next=${encodeURIComponent(next)}`}
                >
                  {signup ? "Sign in" : "Create account"}
                </a>
              </p>
              <div className="border-t pt-5 [&>button]:w-full">
                <DemoButton />
              </div>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
