import Svg, { Path, Circle, Rect, Line } from "react-native-svg";
import { colors } from "@/theme/tokens";

type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function IconBack({ size = 20, color = colors.chalk, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15 4L7 12l8 8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconPlus({ size = 18, color = colors.chalk, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconSearch({ size = 17, color = colors.ghost, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="11" cy="11" r="7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path d="M21 21l-4.3-4.3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconLock({ size = 15, color = colors.smoke, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="5" y="11" width="14" height="9" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path d="M8 11V7a4 4 0 0 1 8 0v4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconCheck({ size = 14, color = colors.black, strokeWidth = 2.6 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 12l5 6L20 5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconPeople({ size = 20, color = colors.chalk, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="9" cy="8" r="3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Circle cx="17" cy="9" r="2.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path
        d="M3 20v-1a6 6 0 0 1 12 0v1M15 14a5 5 0 0 1 5 5v1"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="square"
      />
    </Svg>
  );
}

export function IconClock({ size = 13, color = colors.smoke, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path d="M12 7.5v4.8l3.2 2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconAttach({ size = 20, color = colors.chalk, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 12.5V6.5a3 3 0 0 1 6 0v9a2 2 0 1 1-4 0v-8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="square"
      />
    </Svg>
  );
}

export function IconSend({ size = 18, color = colors.black, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 12h15M13 6l6 6-6 6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconClose({ size = 18, color = colors.chalk, strokeWidth = 1.5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path d="M1 1l16 16M17 1L1 17" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconCamera({ size = 22, color = colors.chalk, strokeWidth = 1.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8h3l2-2.5h6L17 8h3v11H4z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="square"
      />
      <Circle cx="12" cy="13.5" r="3.3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconImage({ size = 22, color = colors.chalk, strokeWidth = 1.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="5" width="18" height="14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Circle cx="9" cy="11" r="1.6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path d="M4 17l5-5 4 4 3-3 4 4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconFile({ size = 22, color = colors.chalk, strokeWidth = 1.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M6 3h9l5 5v13H6z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
      <Path d="M15 3v5h5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconPin({ size = 22, color = colors.chalk, strokeWidth = 1.4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="square"
      />
      <Circle cx="12" cy="9.5" r="2.3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="square" />
    </Svg>
  );
}

export function IconX({ size = 18, color = colors.chalk }: IconProps) {
  return <IconClose size={size} color={color} />;
}

export function IconLine({ size = 20, color = colors.rule }: IconProps) {
  return (
    <Svg width={size} height={2} viewBox={`0 0 ${size} 2`}>
      <Line x1="0" y1="1" x2={size} y2="1" stroke={color} strokeWidth={1} />
    </Svg>
  );
}
