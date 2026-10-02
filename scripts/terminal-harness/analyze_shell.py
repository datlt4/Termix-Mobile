import json,sys
r=json.load(open(sys.argv[1])); sc=dict(r['scen']); vy=r['vy']
print('size',r['size'],'raw',r['raw'])
for name,start,end in [('slow',sc['slow'],sc['flick']),('flick',sc['flick'],sc['flick']+6000)]:
    seg=[(t,y) for t,y in vy if start<=t<end]
    y0=seg[0][1]; moves=[(t,y) for (t,y),(_,py) in zip(seg[1:],seg) if y!=py]
    tc=[t for (ty,t,yy) in r['touches'] if start<=t<end]; te=tc[-1]
    during=[m for m in moves if m[0]<=te]; after=[m for m in moves if m[0]>te]
    print(f"{name}: viewport {y0} -> {seg[-1][1]} (moved {y0-seg[-1][1]} lines) | changes while down {len(during)}, after release {len(after)} (last +{(moves[-1][0]-te) if moves else 0}ms after lift) | first move +{moves[0][0]-tc[0] if moves else None}ms")
