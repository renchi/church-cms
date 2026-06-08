import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Church CMS',
  description: 'Church management system',
}

const navItems = [
  { href: '/', label: 'Home' },
  { href: '/members', label: 'Members' },
  { href: '/events', label: 'Events' },
  { href: '/finance', label: 'Finance' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b border-gray-200 bg-white">
          <nav className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-4">
            <span className="font-semibold">Church CMS</span>
            <ul className="flex gap-4 text-sm">
              {navItems.map(item => (
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
  )
}
