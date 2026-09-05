type ScreenshotProps = {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  sizes?: string;
};

/** Prebuilt responsive sources keep static hosting independent of an image server. */
export function Screenshot({
  src,
  alt,
  width,
  height,
  priority = false,
  sizes = "(max-width: 767px) 100vw, 700px",
}: ScreenshotProps) {
  const base = src.replace(".webp", "");
  return (
    <img
      src={src}
      srcSet={`${base}-640.webp 640w, ${base}-960.webp 960w, ${src} ${width}w`}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
    />
  );
}
