export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.05fr]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-[380px]">{children}</div>
      </div>
      <div className="relative hidden overflow-hidden border-l border-border bg-[#0d0e14] lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_70%_20%,rgba(91,91,240,0.35),transparent),radial-gradient(40%_40%_at_20%_80%,rgba(124,58,237,0.25),transparent)]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="text-[13px] font-medium text-white/60">Synchronous Consulting</div>
          <div>
            <h2 className="max-w-md text-[30px] leading-tight font-semibold tracking-[-0.02em]">Your AI marketing team — with approvals, audit trails and hard limits built in.</h2>
            <ul className="mt-8 space-y-3 text-[14px] text-white/75">
              <li>• Specialist agents plan, write and prepare Instagram content from your Company Brain.</li>
              <li>• Nothing is posted, sent or spent without an approval bound to the exact version.</li>
              <li>• Comment-to-DM sales replies grounded in your approved catalog.</li>
            </ul>
          </div>
          <div className="text-[12px] text-white/40">Official Meta and Higgsfield APIs only. No scraping, no bulk DMs.</div>
        </div>
      </div>
    </div>
  );
}
