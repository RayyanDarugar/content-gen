import { describe, it, expect } from "vitest";
import { resolveRoleRef, roleRefUploadKey } from "@/lib/athena/role-refs";
import type { Category } from "@/lib/types";

const category = (
  style_ref_url: string,
  role_ref_urls: Category["role_ref_urls"],
): Pick<Category, "style_ref_url" | "role_ref_urls"> => ({ style_ref_url, role_ref_urls });

describe("resolveRoleRef", () => {
  it("returns the role ref when present", () => {
    const cat = category("https://brand.example/style.jpg", {
      hook: "https://cdn.example/hook-cemented.jpg",
    });
    expect(resolveRoleRef(cat, "hook")).toBe("https://cdn.example/hook-cemented.jpg");
  });

  it("falls back to style_ref_url when the role is absent", () => {
    const cat = category("https://brand.example/style.jpg", {
      hook: "https://cdn.example/hook-cemented.jpg",
    });
    expect(resolveRoleRef(cat, "payoff")).toBe("https://brand.example/style.jpg");
  });

  it("falls back to style_ref_url when role_ref_urls is undefined", () => {
    const cat = category("https://brand.example/style.jpg", undefined as never);
    expect(resolveRoleRef(cat, "beat")).toBe("https://brand.example/style.jpg");
  });

  it("falls back to style_ref_url when role_ref_urls is null", () => {
    const cat = category("https://brand.example/style.jpg", null as never);
    expect(resolveRoleRef(cat, "single")).toBe("https://brand.example/style.jpg");
  });

  it("falls back to style_ref_url when the role ref is an empty string", () => {
    // Deliberate || semantics: an empty-string role ref is falsy and should
    // fall back rather than resolve to "".
    const cat = category("https://brand.example/style.jpg", { hook: "" });
    expect(resolveRoleRef(cat, "hook")).toBe("https://brand.example/style.jpg");
  });
});

describe("roleRefUploadKey", () => {
  it("returns the suffixed key when usedRoleRef is true", () => {
    expect(roleRefUploadKey("SAT_MYTH", "hook", true)).toBe("SAT_MYTH_hook");
  });

  it("returns the bare category key when usedRoleRef is false", () => {
    expect(roleRefUploadKey("SAT_MYTH", "hook", false)).toBe("SAT_MYTH");
  });
});
