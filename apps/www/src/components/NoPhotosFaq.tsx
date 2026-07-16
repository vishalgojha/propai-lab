import { FaqQuestion } from "@/lib/types";

const NO_PHOTOS_QUESTION: FaqQuestion = {
  question: "Why don't PropAI listings have photos?",
  answer:
    "PropAI's listings come from live WhatsApp broker conversations, not manual uploads, so the inventory shifts daily — units get booked, prices move, availability closes. Static photos would misrepresent the current state faster than they'd help. Every listing routes you straight to the broker on WhatsApp, where they'll share real, current photos, videos, and floor plans on request.",
};

export function getNoPhotosFaq(): FaqQuestion[] {
  return [NO_PHOTOS_QUESTION];
}

export function NoPhotosFaqJsonLd() {
  const faq = getNoPhotosFaq();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: q.answer,
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}

export function NoPhotosFaq() {
  const faq = getNoPhotosFaq();
  return (
    <section aria-label="Frequently asked questions" className="mt-12">
      <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-6">
        Questions
      </h2>
      <div className="space-y-4">
        {faq.map((q) => (
          <div
            key={q.question}
            className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 lg:p-6"
          >
            <h3 className="text-lg font-semibold text-white mb-2">{q.question}</h3>
            <p className="text-[15px] text-zinc-400">{q.answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
