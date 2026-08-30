"use client";

export default function LocalityError() {
  return (
    <main className="www-shell min-h-screen px-4 py-24 text-center text-white">
      <h1 className="text-2xl font-semibold">Locality data is temporarily unavailable</h1>
      <p className="mx-auto mt-3 max-w-xl text-zinc-400">
        We could not load live listings right now. Please try again shortly.
      </p>
    </main>
  );
}
