import Link from 'next/link'

export default function HomePage() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Welcome to Church CMS</h1>
      <p className="text-gray-600">
        A learning project for Docker, Kubernetes, system design, and DDD. Start by browsing the{' '}
        <Link href="/members" className="text-blue-600 underline hover:text-blue-800">
          members list
        </Link>
        .
      </p>
    </section>
  )
}
