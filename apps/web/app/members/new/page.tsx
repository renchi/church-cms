// Server Component: renders on the server and ships no JavaScript of its own.
// Only <RegisterForm> (a Client Component) runs in the browser.

import Link from "next/link";
import { RegisterForm } from "./RegisterForm";

export default function NewMemberPage() {
  return (
    <section className="max-w-md space-y-4">
      <Link href="/members" className="text-sm text-gray-600 hover:text-gray-900">
        ← Back to members
      </Link>
      <h1 className="text-2xl font-semibold">Register a member</h1>
      <RegisterForm />
    </section>
  );
}
