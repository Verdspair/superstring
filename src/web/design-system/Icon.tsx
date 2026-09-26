import {
  Activity,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  Cpu,
  Database,
  Ellipsis,
  FileText,
  Fingerprint,
  Focus,
  Heart,
  History,
  Languages,
  Layers3,
  type LucideIcon,
  Menu,
  MessageSquare,
  Minimize2,
  Palette,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePlus,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";

/** Semantic names keep feature components independent of the chosen icon package. */
const icons = {
  settings: Settings2,
  chat: MessageSquare,
  agent: UserRound,
  memory: Database,
  context: Layers3,
  persona: Fingerprint,
  emotion: Heart,
  plug: Plug,
  more: Ellipsis,
  sliders: SlidersHorizontal,
  users: UsersRound,
  back: ArrowLeft,
  palette: Palette,
  profile: UserRound,
  plus: Plus,
  instructions: FileText,
  chip: Cpu,
  search: Search,
  archive: History,
  clock: Clock3,
  hand: Sparkles,
  compress: Minimize2,
  shield: ShieldCheck,
  scope: Focus,
  book: BookOpen,
  language: Languages,
  trash: Trash2,
  edit: Pencil,
  refresh: RefreshCw,
  power: Power,
  activity: Activity,
  close: X,
  menu: Menu,
  copy: Copy,
  check: Check,
  send: ArrowUp,
  external: ArrowUpRight,
  pause: Pause,
  play: Play,
  help: CircleHelp,
  chevron: ChevronDown,
  new: SquarePlus,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof icons | "brand";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  if (name === "brand")
    return <BrandLogo className={`icon brand-mark size-5 shrink-0 ${className}`} />;
  const Glyph = icons[name];
  return (
    <Glyph
      className={`icon size-4 shrink-0 ${className}`}
      size={18}
      strokeWidth={1.7}
      aria-hidden="true"
      focusable="false"
    />
  );
}
