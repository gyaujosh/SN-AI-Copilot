import React from "react";
import { Route } from "lucide-react";
import claudeMark from "../assets/providers/claude-mark.svg";
import openaiBlack from "../assets/providers/openai-black.svg";
import openaiWhite from "../assets/providers/openai-white.svg";
import type { ProviderId } from "../../shared/types";
import { useTheme } from "../theme/ThemeContext";

export type ProviderFamily = "claude" | "openai" | "openrouter";

/** Whose mark identifies a provider's models. */
export function familyOf(provider: ProviderId): ProviderFamily {
  return provider === "anthropic" ? "claude" : provider;
}

/**
 * Provider marks from the providers' own published assets, unmodified (see
 * assets/providers/SOURCES.md). They identify whose models a row refers to;
 * they are not this extension's branding. OpenRouter has no bundled mark, so
 * it gets a neutral glyph rather than an invented one.
 */
export function ProviderLogo({ family, size = 28 }: { family: ProviderFamily; size?: number }) {
  const { theme } = useTheme();
  const style = { width: size, height: size };
  if (family === "openrouter") {
    return (
      <span className="provider-logo provider-logo-generic" style={style} data-provider={family} aria-hidden="true">
        <Route size={Math.round(size * 0.58)} />
      </span>
    );
  }
  const src = family === "claude" ? claudeMark : theme === "dark" ? openaiWhite : openaiBlack;
  return (
    <span className={`provider-logo provider-logo-${family}`} style={style} data-provider={family} aria-hidden="true">
      <img src={src} alt="" draggable={false} />
    </span>
  );
}
