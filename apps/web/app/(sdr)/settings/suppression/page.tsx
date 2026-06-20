import type { JSX } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import {
  listSuppressedEmails,
  addToSuppressionList,
  removeFromSuppressionList,
  type SuppressionEntry,
} from "@/lib/sdr/suppression-list";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SuppressionSettingsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { entries, total } = await listSuppressedEmails(null, 100, 0);

  async function handleAdd(formData: FormData): Promise<void> {
    "use server";
    const email = (formData.get("email") as string | null)?.trim() ?? "";
    if (!email || !email.includes("@")) return;
    await addToSuppressionList(email, null, "manual");
    revalidatePath("/settings/suppression");
  }

  async function handleRemove(formData: FormData): Promise<void> {
    "use server";
    const id = (formData.get("id") as string | null)?.trim() ?? "";
    if (!id) return;
    await removeFromSuppressionList(id, null);
    revalidatePath("/settings/suppression");
  }

  return (
    <main>
      <h1>Suppression List</h1>
      <p>
        Emails on this list are permanently excluded from all outbound SDR sequences.
        Entries are added automatically when a recipient clicks an unsubscribe link, and
        can also be added or removed manually here.
      </p>

      <form action={handleAdd} className="toolbar">
        <input
          type="email"
          name="email"
          placeholder="prospect@example.com"
          required
          aria-label="Email address to suppress"
        />
        <button type="submit">Add to list</button>
      </form>

      {entries.length === 0 ? (
        <div className="empty">
          <p>No suppressed emails yet.</p>
          <p className="muted">
            Entries appear here when recipients click unsubscribe links or you add them manually above.
          </p>
        </div>
      ) : (
        <>
          <p className="muted">{total} suppressed address{total === 1 ? "" : "es"}</p>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Reason</th>
                <th>Date added</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry: SuppressionEntry) => (
                <tr key={entry.id}>
                  <td>{entry.email}</td>
                  <td>
                    <span className="muted">
                      {entry.reason === "unsubscribe" ? "Unsubscribed" : entry.reason}
                    </span>
                  </td>
                  <td className="muted">
                    {new Date(entry.created_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td>
                    <form action={handleRemove}>
                      <input type="hidden" name="id" value={entry.id} />
                      <button type="submit" className="btn secondary">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
