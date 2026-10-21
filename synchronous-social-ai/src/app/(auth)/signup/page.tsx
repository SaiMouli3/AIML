import { SignupForm } from "@/components/auth-forms";

export const metadata = { title: "Create workspace" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Create your workspace</h1>
      <p className="mt-1 mb-8 text-[13.5px] text-fg-muted">Describe your business once. Your AI team does the rest — with your approval.</p>
      <SignupForm />
    </>
  );
}
