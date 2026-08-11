export default async function handler(request: any, response: any) {
  const workflow_id = request.body?.input?.workflow_id
  const input = request.body?.input?.input

  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)

  if (!workflow_id) {
    return response.status(400).json({
      success: false,
      status: "failed",
      message: "workflow_id is required",
      data: null
    })
  }

  try {
    const hasuraUrl = process.env.NHOST_GRAPHQL_URL
    const adminSecret = process.env.NHOST_ADMIN_SECRET

    if (!hasuraUrl) {
      throw new Error("NHOST_GRAPHQL_URL is not configured")
    }

    if (!adminSecret) {
      throw new Error("NHOST_ADMIN_SECRET is not configured")
    }

    const query = `
      query GetWorkflow($workflow_id: uuid!) {
        workflows(
          where: {
            id: {
              _eq: $workflow_id
            }
          }
        ) {
          id
          org_id
          name
          description
          created_by
          created_at
          updated_at
        }
      }
    `

    const graphqlResponse = await fetch(hasuraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret
      },
      body: JSON.stringify({
        query,
        variables: {
          workflow_id
        }
      })
    })

    const result = await graphqlResponse.json()

    console.log(
      "Hasura response:",
      JSON.stringify(result)
    )

    if (result.errors) {
      throw new Error(
        result.errors[0]?.message ||
          "Hasura query failed"
      )
    }

    const workflows = result.data?.workflows || []

    if (workflows.length === 0) {
      return response.status(404).json({
        success: false,
        status: "failed",
        message: "Workflow not found",
        data: null
      })
    }

    const workflow = workflows[0]

    return response.status(200).json({
      success: true,
      status: "completed",
      message: "Workflow fetched successfully",
      data: JSON.stringify({
        workflow,
        input
      })
    })
  } catch (error: any) {
    console.error(
      "Workflow error:",
      error
    )

    return response.status(500).json({
      success: false,
      status: "failed",
      message:
        error?.message ||
        "Workflow engine failed",
      data: null
    })
  }
}