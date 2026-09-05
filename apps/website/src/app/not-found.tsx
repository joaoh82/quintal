import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main" className="not-found wrap">
      <h1>Wrong room.</h1>
      <p>That page isn’t here. Let’s get you back to the office.</p>
      <Link className="button primary" href="/">
        Back to Quintal
      </Link>
    </main>
  );
}
