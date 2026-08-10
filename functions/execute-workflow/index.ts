export default async function handler(request: any, response: any) {
  const workflow_id = request.body?.input?.workflow_id
  const input = request.body?.input?.input

  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)

  return response.status(200).json({
    success: true,
    status: "completed",
    message: "Step 1: workflow request received",
    data: JSON.stringify({
      workflow_id,
      input
    })
  })
}