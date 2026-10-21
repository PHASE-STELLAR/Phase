import { IpfsDisplayImg } from "@/components/ipfs-display-img"

export function ChamberCatalogThumb({ uri }: { uri: string; collectionId: number }) {
  return <div className="h-12 w-12 shrink-0 overflow-hidden rounded border border-zinc-700">
    <IpfsDisplayImg uri={uri} alt="" className="h-full w-full object-cover" />
  </div>
}
