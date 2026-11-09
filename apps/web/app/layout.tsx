import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Rum } from "./Rum";
import "./globals.css";

export const metadata: Metadata = {
  title: "Church CMS",
  description: "Church management system",
};

const navItems = [
  { href: "/", label: "Home" },
  { href: "/members", label: "Members" },
  { href: "/events", label: "Events" },
  { href: "/finance", label: "Finance" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Browser monitoring is switched by the chart (rum.enabled, rum.debug), so these
  // are read on the SERVER, per request, and handed to <Rum> as props. Not
  // NEXT_PUBLIC_* variables: Next.js writes those into the JavaScript bundle at
  // `next build`, so they'd be fixed in the image CI built, and no Helm value could
  // change them. `connection()` tells Next.js not to prerender this layout at build
  // time, when the Pod's env doesn't exist yet (study-guide §14).
  await connection();
  const rumEnabled = process.env.RUM_ENABLED === "true";
  const rumDebug = process.env.RUM_DEBUG === "true";
  const appVersion = process.env.APP_VERSION ?? "unknown";

  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        {rumEnabled && <Rum version={appVersion} debug={rumDebug} />}
        <header className="border-b border-gray-200 bg-white">
          <nav className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-4">
            <span className="font-semibold">Church CMS</span>
            <ul className="flex gap-4 text-sm">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-gray-600 hover:text-gray-900">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
