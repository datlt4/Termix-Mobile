import json,sys
r=json.load(open(sys.argv[1]))
print('size',r['size'],'errors',r['errors'][:3])
ch=r['changes']; inp=[t for t,d in r['inputs']]
sc=dict(r['scen'])
for name,start,end in [('slow',sc['slow'],sc['flick']),('flick',sc['flick'],sc['flick']+6000)]:
    tc=[t for (ty,t,y) in r['touches'] if start<=t<end]
    ts,te=tc[0],tc[-1]
    c=[t for t in ch if ts<=t<end]
    i=[t for t in inp if ts<=t<end]
    during=[t for t in c if t<=te]
    gaps=[b-a for a,b in zip([ts]+during,during)]
    print(f"{name}: touch {te-ts}ms | wheel reports sent {len(i)} (first +{i[0]-ts if i else None}ms) | screen changes {len(c)} total, {len(during)} while finger down | first change +{c[0]-ts if c else None}ms | max gap while down {max(gaps) if gaps else None}ms | last change +{c[-1]-ts if c else None}ms")
