try { process.loadEnvFile(".env.local"); } catch {}
import { backfillVerificationReports } from "@/lib/reports/backfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const result = await backfillVerificationReports({ apply });
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    eligible: result.eligible,
    existing: result.existing,
    skipped: result.skipped,
    created: result.created,
    wouldCreate: result.wouldCreate,
    invalid: result.invalid,
    failed: result.failed,
    records: result.records,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});