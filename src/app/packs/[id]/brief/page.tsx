import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { BriefDocument } from "@/components/brief-document";
import { authorizeBriefAccessFromCookie } from "@/lib/brief/access";
import { loadBrief } from "@/lib/brief/build";
import { getDictionary } from "@/lib/i18n";
import { readLocale } from "@/lib/i18n/locale";
import { sessionCookie } from "@/lib/session/cookie";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps) {
  const locale = await readLocale();
  const dictionary = getDictionary(locale);
  const { id } = await params;
  return {
    title: `${dictionary.brief.title} · ${dictionary.brand}`,
    description: dictionary.brief.privacyNote,
    other: { "pack-id": id },
  };
}

export default async function BriefPage({ params }: PageProps) {
  const { id } = await params;
  if (!id?.trim()) notFound();

  const jar = await cookies();
  const access = await authorizeBriefAccessFromCookie(id, jar.get(sessionCookie.name)?.value);
  if (!access.ok) notFound();

  const locale = await readLocale();
  const loaded = await loadBrief({ packId: id, locale });
  if (!loaded.ok) notFound();

  return (
    <main className="brief-page min-h-screen bg-stage py-6 print:bg-white print:py-0">
      <BriefDocument payload={loaded.payload} locale={locale} />
    </main>
  );
}
