export default async function handler(request: any, response: any) {
  console.log("METHOD:", request.method)
  console.log("BODY:", request.body)

  const body = request.body ?? {}

  // Support both possible request formats
  const workflow_id =
    body.workflow_id ??
    body.input?.workflow_id

  const input =
    body.input?.input ??
    body.input

  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)

  try {
    return response.status(200).json({
      success: true,
      status: "completed",
      message: "Workflow engine chal gaya!",
      data: JSON.stringify({
        workflow_id,
        input
      })
    })
  } catch (error: any) {
    return response.status(500).json({
      success: false,
      status: "failed",
      message: "workflow engine failed",
      data: JSON.stringify({
        error: error?.message || "unknown error"
      })
    })
  }
}