"use client"

import { useDocsSearch } from "fumadocs-core/search/client"
import { staticClient } from "fumadocs-core/search/client/orama-static"
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  TagsList,
  TagsListItem,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search"
import { useMemo, useState } from "react"

import { navigation } from "../content/navigation.ts"

/**
 * Search over the index the build writes to `/search.json`. The index downloads when the
 * dialog first opens and every query runs in the browser. The tags filter by tab.
 */
export default function StaticSearchDialog(props: SharedProps) {
  const [tag, setTag] = useState<string | undefined>()
  const client = useMemo(() => staticClient({ from: "/search.json", tag }), [tag])
  const search = useDocsSearch({ client })

  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
        <SearchDialogFooter>
          <TagsList tag={tag} onTagChange={setTag} allowClear>
            {navigation.map((tab) => (
              <TagsListItem key={tab.tab} value={tab.tab}>
                {tab.tab}
              </TagsListItem>
            ))}
          </TagsList>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  )
}
