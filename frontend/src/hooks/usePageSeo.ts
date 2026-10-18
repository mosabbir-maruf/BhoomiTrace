import { useEffect } from "react"
import {
  routeDescription,
  routeHref,
  routeSeoTitle,
  type Route,
} from "@/config/navigation"

function updateOrCreateMeta(
  attrName: "name" | "property",
  attrValue: string,
  content: string,
) {
  let element = document.querySelector<HTMLMetaElement>(
    `meta[${attrName}="${attrValue}"]`,
  )
  if (!element) {
    element = document.createElement("meta")
    element.setAttribute(attrName, attrValue)
    document.head.appendChild(element)
  }
  element.setAttribute("content", content)
}

function updateCanonical(url: string) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='canonical']")
  if (!link) {
    link = document.createElement("link")
    link.setAttribute("rel", "canonical")
    document.head.appendChild(link)
  }
  link.setAttribute("href", url)
}

/**
 * Synchronizes HTML document title, meta descriptions, Open Graph,
 * Twitter card tags, and canonical URL dynamically on client-side route changes.
 */
export function usePageSeo(route: Route) {
  useEffect(() => {
    const title = routeSeoTitle(route.id)
    const description = routeDescription(route.id)

    // Base origin or production domain
    const origin =
      typeof window !== "undefined" && window.location.origin
        ? window.location.origin
        : "https://bhoomitrace.org"

    const canonicalPath =
      route.id === "landing"
        ? `${origin}/`
        : `${origin}/${routeHref(route.id, route.param)}`

    // Update Document Title
    document.title = title

    // Update Meta Description
    updateOrCreateMeta("name", "description", description)

    // Update Open Graph tags
    updateOrCreateMeta("property", "og:title", title)
    updateOrCreateMeta("property", "og:description", description)
    updateOrCreateMeta("property", "og:url", canonicalPath)

    // Update Twitter tags
    updateOrCreateMeta("name", "twitter:title", title)
    updateOrCreateMeta("name", "twitter:description", description)

    // Update Canonical URL
    updateCanonical(canonicalPath)
  }, [route.id, route.param])
}
