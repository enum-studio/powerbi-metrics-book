// Whether this build is the public site's copy of the docs (apps/site sets
// PBMB_DOCS_SITE=1) rather than the one the api serves in a deployment. Only
// the public copy links its title to the landing page and says the project is
// not released yet.
export const PUBLIC_SITE = process.env.PBMB_DOCS_SITE === "1";
