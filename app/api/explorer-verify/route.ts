import { NextRequest, NextResponse } from 'next/server';

interface ExplorerVerifyResponse {
  collection_id: number;
  name: string;
  external_url: string;
  verified: boolean;
  verified_at?: number;
  stellar_expert_url?: string;
  error?: string;
}

/**
 * GET /api/explorer-verify?collection_id=...
 * Get explorer metadata and verification status for a collection
 */
export async function GET(request: NextRequest) {
  try {
    const collection_id = request.nextUrl.searchParams.get('collection_id');
    if (!collection_id) {
      return NextResponse.json(
        { error: 'Missing collection_id parameter' },
        { status: 400 }
      );
    }

    const collectionIdNum = parseInt(collection_id, 10);
    if (isNaN(collectionIdNum)) {
      return NextResponse.json(
        { error: 'Invalid collection_id' },
        { status: 400 }
      );
    }

    // TODO: Call explorer metadata contract via Soroban RPC
    // const metadata = await env.call('get_metadata', collectionIdNum);

    const response: ExplorerVerifyResponse = {
      collection_id: collectionIdNum,
      name: 'Unknown Collection',
      external_url: '',
      verified: false,
    };

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      { error: 'Explorer verification failed', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/explorer-verify
 * Register collection metadata with explorer
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.collection_id || !body.name || !body.external_url) {
      return NextResponse.json(
        { error: 'Missing required fields: collection_id, name, external_url' },
        { status: 400 }
      );
    }

    // TODO: Call explorer metadata contract
    // Requires caller authentication via Freighter
    // const result = await env.call('set_explorer_metadata', {
    //   collection_id: body.collection_id,
    //   collection_name: body.name,
    //   external_url: body.external_url,
    // });

    const response: ExplorerVerifyResponse = {
      collection_id: body.collection_id,
      name: body.name,
      external_url: body.external_url,
      verified: false,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Explorer registration failed', details: String(error) },
      { status: 500 }
    );
  }
}
