"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "./ui/button";
import { Field, Input, Notice } from "./ui/primitives";

function useSubmit() {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("INTERNAL", "Something went wrong", null, 500));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function ErrorNotice({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <Notice tone="danger" title={error.message} className="mb-4">
      {error.lines.length ? (
        <ul className="list-disc pl-4">
          {error.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

export function LoginForm() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(async () => {
          await api("/auth/login", { body: { email: f.get("email"), password: f.get("password") } });
          router.push("/overview");
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      <ErrorNotice error={error} />
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
        Sign in
      </Button>
      <p className="text-fg-muted text-center text-[13px]">
        New to Synchronous?{" "}
        <Link href="/signup" className="text-brand-600 font-medium hover:underline">
          Create a workspace
        </Link>
      </p>
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(async () => {
          await api("/auth/signup", {
            body: {
              name: f.get("name"),
              email: f.get("email"),
              password: f.get("password"),
              workspaceName: f.get("workspaceName"),
              timezone: tz,
            },
          });
          router.push("/brain?onboarding=1");
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      <ErrorNotice error={error} />
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required />
      </Field>
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters.">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <Field label="Company / workspace name" htmlFor="workspaceName">
        <Input id="workspaceName" name="workspaceName" required minLength={2} />
      </Field>
      <p className="text-fg-subtle text-[12px]">Timezone detected: {tz}. You can change it in Settings.</p>
      <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
        Create workspace
      </Button>
      <p className="text-fg-muted text-center text-[13px]">
        Already have an account?{" "}
        <Link href="/login" className="text-brand-600 font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function AcceptInviteForm({ token, signedIn }: { token: string; signedIn: boolean }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(async () => {
          await api("/invitations/accept", {
            body: signedIn ? { token } : { token, name: f.get("name"), password: f.get("password") },
          });
          router.push("/overview");
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      <ErrorNotice error={error} />
      {!signedIn ? (
        <>
          <Field label="Your name" htmlFor="name">
            <Input id="name" name="name" required />
          </Field>
          <Field
            label="Choose a password"
            htmlFor="password"
            hint="At least 12 characters. If you already have an account, sign in first."
          >
            <Input id="password" name="password" type="password" minLength={12} required />
          </Field>
        </>
      ) : null}
      <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
        Accept invitation
      </Button>
    </form>
  );
}

export function NewWorkspaceForm() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(async () => {
          await api("/workspaces", {
            body: { name: f.get("name"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          });
          router.push("/brain?onboarding=1");
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      <ErrorNotice error={error} />
      <Field label="Workspace name" htmlFor="ws-name" hint="Agencies: create one workspace per client brand.">
        <Input id="ws-name" name="name" required minLength={2} />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
        Create workspace
      </Button>
    </form>
  );
}
