import { LoginForm } from "@/components/auth-forms";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Sign in</h1>
      <p className="text-fg-muted mt-1 mb-8 text-[13.5px]">Welcome back to Synchronous Social AI.</p>
      <LoginForm />
    </>
  );
}
