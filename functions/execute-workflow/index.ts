import { Request, Response } from 'express'

export default async function handler(req: Request, res: Response) {
  const { workflow_id, input } = req.body
  
  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)

  try {
    return res.json({ 
      success: true, 
      message: "Workflow engine chal gaya!",
      received: {
        workflow_id: workflow_id,
        input: input
      }
    })
  } catch (error: any) {
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    })
  }
}