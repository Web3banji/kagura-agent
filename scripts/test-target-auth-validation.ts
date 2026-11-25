import { validateProjectTargetAuthConfig } from "../src/lib/target-auth/validate";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

// 1. default unconfigured when mode omitted
{
  const r = validateProjectTargetAuthConfig({});
  check("default unconfigured", r.ok && r.value?.targetAuthMode === "unconfigured");
}

// 2. valid modes
for (const m of ["public", "protected", "unconfigured"]) {
  const r = validateProjectTargetAuthConfig({ targetAuthMode: m });
  check(`valid mode ${m}`, r.ok && r.value?.targetAuthMode === m);
}

// 3. invalid mode rejected
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "admin" });
  check("invalid mode rejected", !r.ok);
}

// 4. evidence only when protected
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "public", targetAuthEvidence: { type: "authenticated_identity" } });
  check("evidence rejected in public mode", !r.ok);
}

// 5. valid evidence in protected mode
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "protected", targetAuthEvidence: { type: "authenticated_identity", expectedIdentity: "user@example.com" } });
  check("valid evidence in protected mode", r.ok && r.value?.targetAuthEvidence?.type === "authenticated_identity");
}

// 6. secret-bearing fields rejected
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "protected", targetAuthEvidence: { type: "authenticated_identity", password: "x" } as any });
  check("secret field in evidence rejected", !r.ok);
}
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "protected", api_key: "x" } as any);
  check("secret field at top level rejected", !r.ok);
}

// 7. invalid evidence type rejected
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "protected", targetAuthEvidence: { type: "foo" } });
  check("invalid evidence type rejected", !r.ok);
}

// 8. body must be object
{
  const r = validateProjectTargetAuthConfig(null);
  check("null body rejected", !r.ok);
  const r2 = validateProjectTargetAuthConfig("x");
  check("string body rejected", !r2.ok);
}

// 9. non-protected evidence absent leaves undefined
{
  const r = validateProjectTargetAuthConfig({ targetAuthMode: "unconfigured" });
  check("no evidence when unconfigured", r.ok && r.value?.targetAuthEvidence === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
