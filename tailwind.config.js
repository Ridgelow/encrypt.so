/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bo: {
          black: "#000000",
          coal: "#060608",
          ash: "#0e0e10",
          graphite: "#16161a",
          iron: "#1f1f24",
          rule: "#2e2e34",
          steel: "#4a4a52",
          ghost: "#6b6b73",
          smoke: "#9a9aa2",
          chalk: "#c9c9cf",
          white: "#ffffff",
        },
      },
      fontFamily: {
        wordmark: ["Hacked"],
        display: ["SairaCondensed_600SemiBold"],
        sans: ["Barlow_400Regular"],
        "sans-medium": ["Barlow_500Medium"],
        mono: ["PixelOperatorMono"],
      },
      borderRadius: {
        none: "0px",
        chip: "2px",
      },
    },
  },
  plugins: [],
};
