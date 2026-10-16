import { PackLive } from "@/components/pack-live";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readLocale } from "@/lib/i18n/locale";

export default async function PackPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const locale = await readLocale();
  const params = await searchParams;
  return (
    <>
      <SiteHeader locale={locale} />
      <main>
        <PackLive locale={locale} sessionId={params.session ?? ""} />
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}
