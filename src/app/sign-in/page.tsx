import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { githubOAuthConfigured } from "@/lib/auth/oauth";
import { hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

function errorMessage(code?: string): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    not_configured: "Sign-in is not configured on this server.",
    missing_params: "Sign-in could not be completed (missing parameters).",
    invalid_state: "Sign-in session expired or was invalid. Please try again.",
    access_denied: "Access was denied.",
  };
  return map[code] || "Sign-in failed. Please try again.";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams?: { error?: string; next?: string; signedout?: string };
}) {
  const user = await getCurrentUser();
  if (user) redirect("/command-center");

  const gh = githubOAuthConfigured();
  const db = hasDatabase();
  const next = searchParams?.next && searchParams.next.startsWith("/") ? searchParams.next : "/command-center";
  const err = errorMessage(searchParams?.error);
  const signedOut = searchParams?.signedout === "1";

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-panel/80 p-6 shadow-glow">
        <div className="mb-4">
          <div className="font-tech text-xs tracking-[0.22em] text-accent uppercase">KAGURA</div>
          <h1 className="mt-2 text-xl font-semibold text-fg">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            Sign in to access your KAGURA dashboard. Public stories remain available without signing in.
          </p>
        </div>

        {signedOut ? (
          <div className="mb-3 rounded-md border border-border bg-panel-2/50 px-3 py-2 text-sm text-muted">
            You have been signed out.
          </div>
        ) : null}
        {err ? (
          <div className="mb-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {err}
          </div>
        ) : null}

        {!db ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Database is not configured. User sign-in requires <code>DATABASE_URL</code>.
          </div>
        ) : gh ? (
          <a
            href={`/api/auth/signin/github?next=${encodeURIComponent(next)}`}
            className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border-strong bg-panel-2/60 px-4 py-2.5 text-sm font-medium text-fg hover:border-accent/40 hover:bg-accent/5"
          >
            Continue with GitHub
          </a>
        ) : (
          <div className="rounded-md border border-border bg-panel-2/40 px-3 py-2 text-sm text-muted">
            GitHub sign-in is not configured. Set <code>GITHUB_CLIENT_ID</code> and{" "}
            <code>GITHUB_CLIENT_SECRET</code> on the server.
          </div>
        )}

        <div className="mt-5 flex items-center justify-between text-xs text-muted">
          <Link href="/stories" className="text-accent hover:underline">
            View published stories
          </Link>
          <span>Secure session cookie</span>
        </div>
      </div>
    </div>
  );
}