// The upstream decoder (omggif) ships no type declarations, so this shim is what lets the
// import typecheck at all.
//
// It is deliberately the minimal form TypeScript suggests. A full
// `declare module "omggif" { … }` describing the package's constructors makes the preview
// compiler (typescript 7.x, `tsgo`) run away in generic instantiation until it exhausts memory
// and dies inside its own collector — two different crash sites, same cause, reproduced with
// `tsc --noEmit`. With this one-line form the same check finishes in about a second. The
// surface actually used is therefore typed at the call site, in
// src/server/services/qq-animation-frames.ts.
declare module "omggif";
