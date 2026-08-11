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

    console.log("GraphQL URL configured:", !!hasuraUrl)
    console.log("Admin secret configured:", !!adminSecret)

    if (!hasuraUrl) {
      throw new Error("NHOST_GRAPHQL_URL is not configured")
    }

    if (!adminSecret) {
      throw new Error("NHOST_ADMIN_SECRET is not configured")
    }

    // First: inspect the actual GraphQL query root
    const introspectionQuery = `
      query {
        __schema {
          queryType {
            fields {
              name
            }
          }
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
        query: introspectionQuery
      })
    })

    const result = await graphqlResponse.json()

    console.log(
      "GraphQL schema response:",
      JSON.stringify(result)
    )

    if (result.errors) {
      return response.status(200).json({
        success: false,
        status: "failed",
        message: result.errors[0]?.message || "GraphQL introspection failed",
        data: JSON.stringify(result.errors)
      })
    }

    const fields =
      result.data?.__schema?.queryType?.fields || []

    const fieldNames = fields.map((field: any) => field.name)

    console.log("Query root fields:", fieldNames)

    const workflowsExists =
      fieldNames.includes("workflows")

    return response.status(200).json({
      success: true,
      status: "diagnostic",
      message: workflowsExists
        ? "workflows field EXISTS in Function GraphQL schema"
        : "workflows field DOES NOT EXIST in Function GraphQL schema",
      data: JSON.stringify({
        graphqlUrlConfigured: !!hasuraUrl,
        adminSecretConfigured: !!adminSecret,
        workflowsExists,
        queryRootFields: fieldNames
      })
    })

  } catch (error: any) {
    console.error("Workflow error:", error)

    return response.status(200).json({
      success: false,
      status: "failed",
      message: error?.message || "Workflow engine failed",
      data: null
    })
  }
}