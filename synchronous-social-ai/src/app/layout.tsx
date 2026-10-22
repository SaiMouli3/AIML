import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Synchronous Social AI", template: "%s · Synchronous Social AI" },
  description: "Governed AI marketing operating system for Instagram and Meta.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f7f7f8", width: "device-width", initialScale: 1 };

// Applies the system color scheme before paint without inline user data.
const themeScript = `try{if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "text-[13px]" }} />
      </body>
    </html>
  );
}
