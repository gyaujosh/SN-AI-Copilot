/** @type {import("tailwindcss").Config} */
module.exports = {
  // The panel is styled by index.css; Tailwind contributes its base layer and
  // the few utilities those sources use.
  content: ["./src/**/*.{ts,tsx}", "./public/**/*.html"],
  theme: {
    extend: {
      colors: {
        accent: "#6366f1",
        "accent-hover": "#5558e6",
        accent2: "#8b5cf6",
        surface: "#1a1a1a",
        surface2: "#141414",
      },
    },
  },
  plugins: [],
};
