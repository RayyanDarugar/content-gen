"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Bookmark, ChevronLeft, ChevronRight, Heart, ImageOff, MessageCircle,
  Repeat2, Send, Share2, ThumbsUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeService, platformCharLimit } from "@/lib/platform";
import { PhoneFrame } from "./phone-frame";

// useLayoutEffect warns when it runs during SSR; these previews are only
// ever rendered client-side, but the app router still server-renders
// "use client" components once before hydration, so fall back to a no-op
// effect on the server rather than fighting that warning.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface PreviewProps {
  imageUrls: string[];
  caption: string;
  accountName: string;
  avatarUrl: string;
  aspectRatio: string;
}

// Every remote image (post slide or avatar) falls back to a neutral
// placeholder on load failure instead of leaving a blank hole in the
// preview. Keyed by src at the call site so switching slides resets the
// failure state instead of getting stuck on the first broken image.
function PreviewImage({
  src, alt, className, fit = "cover",
}: { src?: string; alt: string; className?: string; fit?: "cover" | "contain" }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={cn("flex items-center justify-center bg-muted/60 text-muted-foreground", className)}>
        <ImageOff className="size-6" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={cn(fit === "cover" ? "object-cover" : "object-contain", className)}
    />
  );
}

function Avatar({ src, name, size = 32 }: { src?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  if (!src || failed) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
      >
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full object-cover"
    />
  );
}

// Shared prev/next + current-index state for TikTok and Instagram, whose
// previews stay a carousel (unlike X, which flattens multi-image posts into
// a mosaic — see XMosaic below).
function useSlideIndex(count: number) {
  const [current, setCurrent] = useState(0);
  const clamped = count > 0 ? Math.min(current, count - 1) : 0;
  const prev = () => setCurrent((c) => (c - 1 + count) % count);
  const next = () => setCurrent((c) => (c + 1) % count);
  return { current: clamped, prev, next };
}

function SlideNav({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }) {
  return (
    <>
      <button
        type="button"
        aria-label="Previous slide"
        onClick={onPrev}
        className="absolute left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1 text-white transition-colors hover:bg-black/60"
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Next slide"
        onClick={onNext}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1 text-white transition-colors hover:bg-black/60"
      >
        <ChevronRight className="size-4" />
      </button>
    </>
  );
}

// Real overflow measurement rather than a character-count guess — where a
// line-clamped column actually wraps depends on font metrics, a bold
// username prefix, and container width, all of which a length heuristic
// gets wrong in both directions. Silently clipping caption text nobody was
// told about is the one failure mode this preview exists to prevent.
function useIsClamped<T extends HTMLElement>(
  deps: React.DependencyList,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [clamped, setClamped] = useState(false);
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    setClamped(!!el && el.scrollHeight - el.clientHeight > 1);
  }, deps);
  return [ref, clamped];
}

function TikTokPreview({ imageUrls, caption, accountName, avatarUrl, aspectRatio }: PreviewProps) {
  const slides = imageUrls.length > 0 ? imageUrls : [undefined];
  const { current, prev, next } = useSlideIndex(slides.length);
  const multi = slides.length > 1;
  return (
    <PhoneFrame aspectRatio={aspectRatio}>
      <div className="absolute inset-0">
        <PreviewImage
          key={`${current}-${slides[current] ?? "empty"}`}
          src={slides[current]}
          alt={`Slide ${current + 1}`}
          className="absolute inset-0 h-full w-full"
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/60 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/75 to-transparent" />

        <div className="absolute inset-x-0 top-3 flex items-center justify-center gap-4 text-sm font-medium text-white/70">
          <span>Following</span>
          <span className="border-b-2 border-white pb-0.5 text-white">For You</span>
        </div>

        {multi && (
          <span className="absolute right-2.5 top-2.5 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white">
            {current + 1}/{slides.length}
          </span>
        )}

        <div className="absolute bottom-4 right-2 flex flex-col items-center gap-4">
          <Avatar src={avatarUrl} name={accountName} size={38} />
          <Heart className="size-7 text-white drop-shadow" />
          <MessageCircle className="size-7 text-white drop-shadow" />
          <Bookmark className="size-7 text-white drop-shadow" />
          <Share2 className="size-7 text-white drop-shadow" />
        </div>

        <div className="absolute bottom-3 left-3 right-16 text-white">
          <p className="text-sm font-semibold">@{accountName}</p>
          <p className="mt-1 line-clamp-2 text-sm text-white/90">{caption}</p>
        </div>

        {multi && <SlideNav onPrev={prev} onNext={next} />}
      </div>
    </PhoneFrame>
  );
}

function InstagramPreview({ imageUrls, caption, accountName, avatarUrl, aspectRatio }: PreviewProps) {
  const slides = imageUrls.length > 0 ? imageUrls : [undefined];
  const { current, prev, next } = useSlideIndex(slides.length);
  const multi = slides.length > 1;
  const [captionRef, clamped] = useIsClamped<HTMLParagraphElement>([caption, accountName]);
  return (
    <PhoneFrame aspectRatio={aspectRatio}>
      <div className="absolute inset-0 flex flex-col bg-black">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <Avatar src={avatarUrl} name={accountName} size={26} />
          <span className="text-sm font-semibold text-white">{accountName}</span>
        </div>

        <div className="relative flex-1 bg-neutral-900">
          <PreviewImage
            key={`${current}-${slides[current] ?? "empty"}`}
            src={slides[current]}
            alt={`Slide ${current + 1}`}
            className="absolute inset-0 h-full w-full"
          />
          {multi && (
            <>
              <SlideNav onPrev={prev} onNext={next} />
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
                {slides.map((_, i) => (
                  <span
                    key={i}
                    className={cn("size-1.5 rounded-full", i === current ? "bg-white" : "bg-white/40")}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 px-3 pt-2 text-white">
          <Heart className="size-6" />
          <MessageCircle className="size-6" />
          <Send className="size-6" />
          <Bookmark className="ml-auto size-6" />
        </div>

        <p ref={captionRef} className="shrink-0 line-clamp-2 px-3 pb-2.5 pt-1.5 text-xs leading-snug text-white">
          <span className="font-semibold">{accountName}</span> {caption}
          {clamped && <span className="text-white/50"> … more</span>}
        </p>
      </div>
    </PhoneFrame>
  );
}

function LinkedInPreview({ imageUrls, caption, accountName, avatarUrl, aspectRatio }: PreviewProps) {
  const slides = imageUrls.length > 0 ? imageUrls : [undefined];
  const { current, prev, next } = useSlideIndex(slides.length);
  const multi = slides.length > 1;
  const [captionRef, clamped] = useIsClamped<HTMLParagraphElement>([caption]);
  return (
    <PhoneFrame aspectRatio={aspectRatio}>
      <div className="absolute inset-0 flex flex-col bg-white text-neutral-900">
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
          <Avatar src={avatarUrl} name={accountName} size={34} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{accountName}</p>
            <p className="truncate text-xs leading-tight text-neutral-500">{accountName} · Business Page</p>
          </div>
        </div>

        <p ref={captionRef} className="shrink-0 line-clamp-3 px-3 pt-2 text-[13px] leading-snug">
          {caption}
          {clamped && <span className="font-semibold text-neutral-500"> …see more</span>}
        </p>

        <div className="relative mt-2 flex-1 bg-neutral-100">
          <PreviewImage
            key={`${current}-${slides[current] ?? "empty"}`}
            src={slides[current]}
            alt={`Slide ${current + 1}`}
            className="absolute inset-0 h-full w-full"
          />
          {multi && (
            <>
              <SlideNav onPrev={prev} onNext={next} />
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-black/30 px-1.5 py-1">
                {slides.map((_, i) => (
                  <span
                    key={i}
                    className={cn("size-1.5 rounded-full", i === current ? "bg-white" : "bg-white/50")}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-around border-t px-2 py-2 text-neutral-600">
          <ThumbsUp className="size-5" />
          <MessageCircle className="size-5" />
          <Repeat2 className="size-5" />
          <Send className="size-5" />
        </div>
      </div>
    </PhoneFrame>
  );
}

// X carries no carousels — a multi-slide idea collapses into a single
// mosaic tile the same way X's own composer would render it, so the
// preview can surface that crop loss instead of hiding it.
function XMosaic({ imageUrls }: { imageUrls: string[] }) {
  const n = imageUrls.length;
  if (n === 1) {
    return <PreviewImage src={imageUrls[0]} alt="Post image" className="absolute inset-0 h-full w-full" />;
  }
  if (n === 2) {
    return (
      <div className="absolute inset-0 grid grid-cols-2 gap-0.5">
        {imageUrls.map((u, i) => (
          <PreviewImage key={i} src={u} alt={`Image ${i + 1}`} className="h-full w-full" />
        ))}
      </div>
    );
  }
  if (n === 3) {
    return (
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5">
        <PreviewImage src={imageUrls[0]} alt="Image 1" className="row-span-2 h-full w-full" />
        <PreviewImage src={imageUrls[1]} alt="Image 2" className="h-full w-full" />
        <PreviewImage src={imageUrls[2]} alt="Image 3" className="h-full w-full" />
      </div>
    );
  }
  const extra = n - 4;
  return (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5">
      {imageUrls.slice(0, 4).map((u, i) => (
        <div key={i} className="relative h-full w-full">
          <PreviewImage src={u} alt={`Image ${i + 1}`} className="h-full w-full" />
          {i === 3 && extra > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-semibold text-white">
              +{extra}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function XPreview({ imageUrls, caption, accountName, avatarUrl, aspectRatio }: PreviewProps) {
  const handle = `@${accountName.trim().toLowerCase().replace(/\s+/g, "")}`;
  const limit = platformCharLimit("x")!;
  const overflow = caption.length > limit;
  return (
    <PhoneFrame aspectRatio={aspectRatio}>
      <div className="absolute inset-0 flex flex-col bg-white text-neutral-900">
        <div className="flex shrink-0 items-start gap-2 px-3 pt-3 text-sm">
          <Avatar src={avatarUrl} name={accountName} size={34} />
          <div className="min-w-0 leading-tight">
            <span className="font-semibold">{accountName}</span>{" "}
            <span className="text-neutral-500">{handle}</span>
          </div>
        </div>

        <p className="shrink-0 whitespace-pre-wrap px-3 pt-1.5 text-[13px] leading-snug">
          {overflow ? caption.slice(0, limit) : caption}
          {overflow && <span className="bg-red-100 text-red-600">{caption.slice(limit)}</span>}
        </p>

        {imageUrls.length > 0 && (
          <div className="relative mx-3 mb-3 mt-2 flex-1 overflow-hidden rounded-xl border">
            <XMosaic imageUrls={imageUrls} />
          </div>
        )}
      </div>
    </PhoneFrame>
  );
}

function GenericPreview({ imageUrls, caption, aspectRatio }: PreviewProps) {
  return (
    <PhoneFrame aspectRatio={aspectRatio}>
      <div className="absolute inset-0 flex flex-col bg-neutral-900">
        <div className="relative flex-1">
          <PreviewImage src={imageUrls[0]} alt="Post image" className="absolute inset-0 h-full w-full" />
        </div>
        <p className="shrink-0 whitespace-pre-wrap px-3 py-2 text-xs text-white/90">{caption}</p>
      </div>
    </PhoneFrame>
  );
}

export function PlatformPreview({
  service, imageUrls, caption, accountName, avatarUrl, aspectRatio,
}: {
  service: string;
  imageUrls: string[];
  caption: string;
  accountName: string;
  avatarUrl: string;
  aspectRatio: string;
}) {
  const key = normalizeService(service);
  const props = { imageUrls, caption, accountName, avatarUrl, aspectRatio };
  if (key === "tiktok") return <TikTokPreview {...props} />;
  if (key === "instagram") return <InstagramPreview {...props} />;
  if (key === "linkedin") return <LinkedInPreview {...props} />;
  if (key === "x") return <XPreview {...props} />;
  return <GenericPreview {...props} />;
}
