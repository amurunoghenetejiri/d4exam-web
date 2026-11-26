import {
  BookOpen,
  FileText,
  ClipboardList,
  File,
} from "lucide-react";

export type MaterialType =
  | "notes"
  | "assignment"
  | "study_guide"
  | "past_question"
  | "reading_tips"
  | "other";

export const TYPE_OPTIONS: {
  value: MaterialType;
  label: string;
  cat: "notes" | "assignment" | "past_question" | "others";
}[] = [
  { value: "notes", label: "Note", cat: "notes" },
  { value: "assignment", label: "Assignment", cat: "assignment" },
  { value: "past_question", label: "Past Question", cat: "past_question" },
  { value: "study_guide", label: "Study Guide", cat: "others" },
  { value: "reading_tips", label: "Reading Tips", cat: "others" },
  { value: "other", label: "Other", cat: "others" },
];

export const CAT_META = {
  notes: {
    label: "Notes",
    icon: FileText,
    wrap: "bg-violet-50 text-violet-600",
    badge: "bg-violet-100 text-violet-700",
  },
  assignment: {
    label: "Assignments",
    icon: ClipboardList,
    wrap: "bg-emerald-50 text-emerald-600",
    badge: "bg-emerald-100 text-emerald-700",
  },
  past_question: {
    label: "Past Questions",
    icon: BookOpen,
    wrap: "bg-orange-50 text-orange-600",
    badge: "bg-orange-100 text-orange-700",
  },
  others: {
    label: "Others",
    icon: File,
    wrap: "bg-sky-50 text-sky-600",
    badge: "bg-sky-100 text-sky-700",
  },
} as const;

export const MAX_FILES = 50;
export const MAX_FILE_MB = 50;

export type CourseOpt = { id: string; code: string; name: string };

export type MaterialRow = {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  material_type: string;
  file_url: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  uploader_role: string;
  uploader_name: string | null;
  uploaded_by: string;
  created_at: string;
  download_count?: number | null;
  tags?: string | null;
  /** OCR / handwriting conversion text (optional column) */
  ocr_text?: string | null;
  ocr_status?: string | null;
  converted_pdf_url?: string | null;
};

export function typeMeta(t: string) {
  const o = TYPE_OPTIONS.find((x) => x.value === t);
  const cat = o?.cat ?? "others";
  return { ...CAT_META[cat], label: o?.label ?? t, cat };
}

export function formatBytes(n: number | null | undefined) {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}
