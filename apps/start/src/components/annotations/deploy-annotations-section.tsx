import Syntax from '@/components/syntax';
import { useAppContext } from '@/hooks/use-app-context';

import type { IServiceClient } from '@openpanel/db';

/**
 * How to post an annotation from a deploy pipeline.
 *
 * Lives on the tracking tab because that is the "how do I send you things"
 * page and it already has the client picker: an annotation is authenticated
 * with the same client id and secret as an event, so the credential someone is
 * looking at here is the credential this needs.
 *
 * The body shown is exactly what `POST /annotations` accepts — no `projectId`,
 * because the client secret already names one project and a second, forgeable
 * answer to "whose annotation is this" is precisely what the route avoids.
 */
export function DeployAnnotationsSection({
  client,
}: {
  client: IServiceClient | null;
}) {
  const context = useAppContext();
  const apiUrl = context.apiUrl || 'https://api.openpanel.dev';

  const code = `curl -X POST ${apiUrl}/annotations \\
  -H 'openpanel-client-id: ${client?.id ?? 'YOUR_CLIENT_ID'}' \\
  -H 'openpanel-client-secret: YOUR_CLIENT_SECRET' \\
  -H 'content-type: application/json' \\
  -d '{
    "text": "Deployed v2.4.0",
    "tags": ["deploy", "api"]
  }'`;

  return (
    <div className="col gap-2">
      <div>
        <h3 className="font-semibold">Deploy annotations</h3>
        <p className="text-muted-foreground text-sm">
          Mark deploys and incidents on your metric charts from CI. Needs a{' '}
          <span className="font-medium">write</span> or{' '}
          <span className="font-medium">root</span> client and its secret.
        </p>
      </div>

      <Syntax className="border" code={code} language="bash" />

      <div className="text-muted-foreground text-sm">
        <p className="mb-1">All fields except `text` are optional:</p>
        <ul className="list-disc pl-5">
          <li>
            <code>time</code> — ISO timestamp. Defaults to now, which is what a
            deploy hook usually means.
          </li>
          <li>
            <code>timeEnd</code> — ISO timestamp. Set it to mark a period (a
            deploy window, an incident) instead of a point.
          </li>
          <li>
            <code>tags</code> — used by the tag filter on the dashboard.
          </li>
          <li>
            <code>dashboardId</code> — omit to show the annotation on every
            dashboard in this project.
          </li>
        </ul>
      </div>
    </div>
  );
}
