const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const parts = (iso: string, abbreviate: boolean): string => {
  const [year, month, day] = iso.split("-")
  const name = months[Number(month) - 1]

  if (year === undefined || day === undefined || name === undefined)
    throw new Error(`"${iso}" is not an ISO date`)

  return `${abbreviate ? name.slice(0, 3) : name} ${Number(day)}, ${year}`
}

/** An ISO date as "Oct 4, 2026". */
export const shortDate = (iso: string): string => parts(iso, true)

/** An ISO date as "October 4, 2026". */
export const longDate = (iso: string): string => parts(iso, false)
